/* global __filename, $ */

import { getLogger } from 'jitsi-meet-logger';
import { $iq, Strophe } from 'strophe.js';

import * as CodecMimeType from '../../service/RTC/CodecMimeType';
import MediaDirection from '../../service/RTC/MediaDirection';
import {
    ICE_DURATION,
    ICE_STATE_CHANGED
} from '../../service/statistics/AnalyticsEvents';
import XMPPEvents from '../../service/xmpp/XMPPEvents';
import { SS_DEFAULT_FRAME_RATE } from '../RTC/ScreenObtainer';
import SDP from '../sdp/SDP';
import SDPDiffer from '../sdp/SDPDiffer';
import SDPUtil from '../sdp/SDPUtil';
import Statistics from '../statistics/statistics';
import AsyncQueue from '../util/AsyncQueue';
import GlobalOnErrorHandler from '../util/GlobalOnErrorHandler';
import { integerHash } from '../util/StringUtils';

import browser from './../browser';
import JingleSession from './JingleSession';
import * as JingleSessionState from './JingleSessionState';
import MediaSessionEvents from './MediaSessionEvents';
import SignalingLayerImpl from './SignalingLayerImpl';
import XmppConnection from './XmppConnection';

const logger = getLogger(__filename);

/**
 * Constant tells how long we're going to wait for IQ response, before timeout
 * error is  triggered.
 * @type {number}
 */
const IQ_TIMEOUT = 10000;

/*
 * The default number of samples (per stat) to keep when webrtc stats gathering
 * is enabled in TraceablePeerConnection.
 */
const DEFAULT_MAX_STATS = 300;

/**
 * The time duration for which the client keeps gathering ICE candidates to be sent out in a single IQ.
 * @type {number} timeout in ms.
 */
const ICE_CAND_GATHERING_TIMEOUT = 150;

/**
 * @typedef {Object} JingleSessionPCOptions
 * @property {Object} abTesting - A/B testing related options (ask George).
 * @property {boolean} abTesting.enableSuspendVideoTest - enables the suspend
 * video test ?(ask George).
 * @property {boolean} disableH264 - Described in the config.js[1].
 * @property {boolean} disableRtx - Described in the config.js[1].
 * @property {boolean} disableSimulcast - Described in the config.js[1].
 * @property {boolean} enableInsertableStreams - Set to true when the insertable streams constraints is to be enabled
 * on the PeerConnection.
 * @property {boolean} enableLayerSuspension - Described in the config.js[1].
 * @property {boolean} failICE - it's an option used in the tests. Set to
 * <tt>true</tt> to block any real candidates and make the ICE fail.
 * @property {boolean} gatherStats - Described in the config.js[1].
 * @property {object} p2p - Peer to peer related options (FIXME those could be
 * fetched from config.p2p on the upper level).
 * @property {boolean} preferH264 - Described in the config.js[1].
 * @property {Object} testing - Testing and/or experimental options.
 * @property {boolean} webrtcIceUdpDisable - Described in the config.js[1].
 * @property {boolean} webrtcIceTcpDisable - Described in the config.js[1].
 *
 * [1]: https://github.com/jitsi/jitsi-meet/blob/master/config.js
 */
/**
 *
 */
export default class JingleSessionPC extends JingleSession {
    /**
     * Parses 'senders' attribute of the video content.
     * @param {jQuery} jingleContents
     * @return {string|null} one of the values of content "senders" attribute
     * defined by Jingle. If there is no "senders" attribute or if the value is
     * invalid then <tt>null</tt> will be returned.
     * @private
     */
    static parseVideoSenders(jingleContents) {
        const videoContents = jingleContents.find('>content[name="video"]');

        if (videoContents.length) {
            const senders = videoContents[0].getAttribute('senders');

            if (senders === 'both'
                || senders === 'initiator'
                || senders === 'responder'
                || senders === 'none') {
                return senders;
            }
        }

        return null;
    }

    /**
     * Parses the video max frame height value out of the 'content-modify' IQ.
     *
     * @param {jQuery} jingleContents - A jQuery selector pointing to the '>jingle' element.
     * @returns {Number|null}
     */
    static parseMaxFrameHeight(jingleContents) {
        const maxFrameHeightSel = jingleContents.find('>content[name="video"]>max-frame-height');

        return maxFrameHeightSel.length ? Number(maxFrameHeightSel.text()) : null;
    }

    /* eslint-disable max-params */

    /**
     * Creates new <tt>JingleSessionPC</tt>
     * @param {string} sid the Jingle Session ID - random string which identifies the session
     * @param {string} localJid our JID
     * @param {string} remoteJid remote peer JID
     * @param {XmppConnection} connection - The XMPP connection instance.
     * @param mediaConstraints the media constraints object passed to createOffer/Answer, as defined
     * by the WebRTC standard
     * @param iceConfig the ICE servers config object as defined by the WebRTC standard.
     * @param {boolean} isP2P indicates whether this instance is meant to be used in a direct, peer to
     * peer connection or <tt>false</tt> if it's a JVB connection.
     * @param {boolean} isInitiator indicates if it will be the side which initiates the session.
     * @constructor
     *
     * @implements {SignalingLayer}
     */
    constructor(
        sid,
        localJid,
        remoteJid,
        connection,
        mediaConstraints,
        iceConfig,
        isP2P,
        isInitiator) {
        super(
            sid,
            localJid,
            remoteJid, connection, mediaConstraints, iceConfig, isInitiator);

        /**
         * The bridge session's identifier. One Jingle session can during
         * it's lifetime participate in multiple bridge sessions managed by
         * Jicofo. A new bridge session is started whenever Jicofo sends
         * 'session-initiate' or 'transport-replace'.
         *
         * @type {?string}
         * @private
         */
        this._bridgeSessionId = null;

        /**
         * used to update Jicofo once the XMPP connection goes back online.
         * @type {SDP|undefined}
         * @private
         */
        this._cachedOldLocalSdp = undefined;

        /**
         * used to update Jicofo once the XMPP connection goes back online.
         * @type {SDP|undefined}
         * @private
         */
        this._cachedNewLocalSdp = undefined;

        /**
         * Stores result of {@link window.performance.now()} at the time when
         * ICE enters 'checking' state.
         * @type {number|null} null if no value has been stored yet
         * @private
         */
        this._iceCheckingStartedTimestamp = null;

        /**
         * Stores result of {@link window.performance.now()} at the time when
         * first ICE candidate is spawned by the peerconnection to mark when
         * ICE gathering started. That's, because ICE gathering state changed
         * events are not supported by most of the browsers, so we try something
         * that will work everywhere. It may not be as accurate, but given that
         * 'host' candidate usually comes first, the delay should be minimal.
         * @type {number|null} null if no value has been stored yet
         * @private
         */
        this._gatheringStartedTimestamp = null;

        /**
         * Local preference for the receive video max frame height.
         *
         * @type {Number|undefined}
         */
        this.localRecvMaxFrameHeight = undefined;

        /**
         * Indicates whether or not this session is willing to send/receive
         * video media. When set to <tt>false</tt> the underlying peer
         * connection will disable local video transfer and the remote peer will
         * be will be asked to stop sending video via 'content-modify' IQ
         * (the senders attribute of video contents will be adjusted
         * accordingly). Note that this notification is sent only in P2P
         * session, because Jicofo does not support it yet. Obviously when
         * the value is changed from <tt>false</tt> to <tt>true</tt> another
         * notification will be sent to resume video transfer on the remote
         * side.
         * @type {boolean}
         * @private
         */
        this._localVideoActive = true;

        /**
         * Indicates whether or not the remote peer has video transfer active.
         * When set to <tt>true</tt> it means that remote peer is neither
         * sending nor willing to receive video. In such case we'll ask
         * our peerconnection to stop sending video by calling
         * {@link TraceablePeerConnection.setVideoTransferActive} with
         * <tt>false</tt>.
         * @type {boolean}
         * @private
         */
        this._remoteVideoActive = true;

        /**
         * Marks that ICE gathering duration has been reported already. That
         * prevents reporting it again, after eventual 'transport-replace' (JVB
         * conference migration/ICE restart).
         * @type {boolean}
         * @private
         */
        this._gatheringReported = false;

        this.lasticecandidate = false;
        this.closed = false;

        /**
         * Indicates whether or not this <tt>JingleSessionPC</tt> is used in
         * a peer to peer type of session.
         * @type {boolean} <tt>true</tt> if it's a peer to peer
         * session or <tt>false</tt> if it's a JVB session
         */
        this.isP2P = isP2P;

        /**
         * Remote preference for the receive video max frame height.
         *
         * @type {Number|undefined}
         */
        this.remoteRecvMaxFrameHeight = undefined;

        /**
         * The signaling layer implementation.
         * @type {SignalingLayerImpl}
         */
        this.signalingLayer = new SignalingLayerImpl();

        /**
         * The queue used to serialize operations done on the peerconnection.
         *
         * @type {AsyncQueue}
         */
        this.modificationQueue = new AsyncQueue();

        /**
         * Flag used to guarantee that the connection established event is
         * triggered just once.
         * @type {boolean}
         */
        this.wasConnected = false;

        /**
         * Keeps track of how long (in ms) it took from ICE start to ICE
         * connect.
         *
         * @type {number}
         */
        this.establishmentDuration = undefined;

        this._xmppListeners = [];
        this._xmppListeners.push(
            connection.addEventListener(
                XmppConnection.Events.CONN_STATUS_CHANGED,
                this.onXmppStatusChanged.bind(this))
        );

        this._removeSenderVideoConstraintsChangeListener = undefined;
    }

    /* eslint-enable max-params */

    /**
     * Checks whether or not this session instance is still operational.
     * @private
     * @returns {boolean} {@code true} if operation or {@code false} otherwise.
     */
    _assertNotEnded() {
        return this.state !== JingleSessionState.ENDED;
    }

    /**
     * @inheritDoc
     * @param {JingleSessionPCOptions} options  - a set of config options.
     */
    doInitialize(options) {
        console.log("----------Jingle Session doInitialize-----------")

        this.failICE = Boolean(options.failICE);
        this.lasticecandidate = false;
        this.options = options;

        this.isReconnect = false;

        this.wasstable = false;
        this.webrtcIceUdpDisable = Boolean(options.webrtcIceUdpDisable);
        this.webrtcIceTcpDisable = Boolean(options.webrtcIceTcpDisable);

        const pcOptions = { disableRtx: options.disableRtx };

        pcOptions.capScreenshareBitrate = false;
        pcOptions.enableInsertableStreams = options.enableInsertableStreams;
        pcOptions.videoQuality = options.videoQuality;
        pcOptions.forceTurnRelay = options.forceTurnRelay;
        pcOptions.audioQuality = options.audioQuality;
        pcOptions.usesUnifiedPlan = true

        // H264 does not support simulcast, so it needs to be disabled.
        pcOptions.disableSimulcast
            = options.disableSimulcast
            || (options.preferH264 && !options.disableH264)
            || (options.videoQuality && options.videoQuality.preferredCodec === CodecMimeType.H264);

        // Disable simulcast for low fps screenshare and enable it for high fps screenshare.
        // testing.capScreenshareBitrate config.js setting has now been deprecated.
        pcOptions.capScreenshareBitrate = pcOptions.disableSimulcast
            || !(typeof options.desktopSharingFrameRate?.max === 'number'
                && options.desktopSharingFrameRate?.max > SS_DEFAULT_FRAME_RATE);

        this.peerconnection
            = this.rtc.createPeerConnection(
                this.signalingLayer,
                this.iceConfig,
                this.isP2P,
                pcOptions);

        this.peerconnection.onicecandidate = ev => {
            if (!ev) {
                // There was an incomplete check for ev before which left
                // the last line of the function unprotected from a potential
                // throw of an exception. Consequently, it may be argued that
                // the check is unnecessary. Anyway, I'm leaving it and making
                // the check complete.
                return;
            }

            // XXX this is broken, candidate is not parsed.
            const candidate = ev.candidate;
            const now = window.performance.now();

            if (candidate) {
                if (this._gatheringStartedTimestamp === null) {
                    this._gatheringStartedTimestamp = now;
                }

                // Discard candidates of disabled protocols.
                let protocol = candidate.protocol;

                if (typeof protocol === 'string') {
                    protocol = protocol.toLowerCase();
                    if (protocol === 'tcp' || protocol === 'ssltcp') {
                        if (this.webrtcIceTcpDisable) {
                            return;
                        }
                    } else if (protocol === 'udp') {
                        if (this.webrtcIceUdpDisable) {
                            return;
                        }
                    }
                }
            } else if (!this._gatheringReported) {
                this._gatheringReported = true;
            }
            this.sendIceCandidate(candidate);
        };

        // Note there is a change in the spec about closed:
        // This value moved into the RTCPeerConnectionState enum in
        // the May 13, 2016 draft of the specification, as it reflects the state
        // of the RTCPeerConnection, not the signaling connection. You now
        // detect a closed connection by checking for connectionState to be
        // "closed" instead.
        // I suppose at some point this will be moved to onconnectionstatechange
        this.peerconnection.onsignalingstatechange = () => {
            if (this.peerconnection.signalingState === 'stable') {
                this.wasstable = true;
            } else if (this.peerconnection.signalingState === 'closed'
                || this.peerconnection.connectionState === 'closed') {
                this.room.eventEmitter.emit(XMPPEvents.SUSPEND_DETECTED, this);
            }
        };

        /**
         * The oniceconnectionstatechange event handler contains the code to
         * execute when the iceconnectionstatechange event, of type Event,
         * is received by this RTCPeerConnection. Such an event is sent when
         * the value of RTCPeerConnection.iceConnectionState changes.
         */
        this.peerconnection.oniceconnectionstatechange = () => {
            const now = window.performance.now();
            let isStable = false;

            this.room.eventEmitter.emit(
                XMPPEvents.ICE_CONNECTION_STATE_CHANGED,
                this,
                this.peerconnection.iceConnectionState);
            switch (this.peerconnection.iceConnectionState) {
                case 'checking':
                    this._iceCheckingStartedTimestamp = now;
                    break;
                case 'connected':
                    // Informs interested parties that the connection has been restored. This includes the case when
                    // media connection to the bridge has been restored after an ICE failure by using session-terminate.
                    if (this.peerconnection.signalingState === 'stable') {
                        isStable = true;
                        const usesTerminateForRestart = !this.options.enableIceRestart

                        if (this.isReconnect || usesTerminateForRestart) {
                            this.room.eventEmitter.emit(
                                XMPPEvents.CONNECTION_RESTORED, this);
                        }
                    }

                    // Add a workaround for an issue on chrome in Unified plan when the local endpoint is the offerer.
                    // The 'signalingstatechange' event for 'stable' is handled after the 'iceconnectionstatechange' event
                    // for 'completed' is handled by the client. This prevents the client from firing a
                    // CONNECTION_ESTABLISHED event for the p2p session. As a result, the offerer continues to stay on the
                    // jvb connection while the remote peer switches to the p2p connection breaking the media flow between
                    // the endpoints.
                    // TODO - file a chromium bug and add the information here.
                    if (!this.wasConnected
                        && (this.wasstable
                            || isStable
                            || (this.usesUnifiedPlan && this.isInitiator && browser.isChromiumBased()))) {

                        // Switch between ICE gathering and ICE checking whichever
                        // started first (scenarios are different for initiator
                        // vs responder)
                        const iceStarted
                            = Math.min(
                                this._iceCheckingStartedTimestamp,
                                this._gatheringStartedTimestamp);

                        this.establishmentDuration = now - iceStarted;
                        this.wasConnected = true;
                        this.room.eventEmitter.emit(
                            XMPPEvents.CONNECTION_ESTABLISHED, this);
                    }
                    this.isReconnect = false;
                    break;
            }
        };

       
        // The signaling layer will bind it's listeners at this point
        this.signalingLayer.setChatRoom(this.room);
    }

    /**
     * Remote preference for receive video max frame height.
     *
     * @returns {Number|undefined}
     */
    getRemoteRecvMaxFrameHeight() {
        if (this.isP2P) {
            return this.remoteRecvMaxFrameHeight;
        }

        return undefined;
    }

    /**
     * Sends given candidate in Jingle 'transport-info' message.
     * @param {RTCIceCandidate} candidate the WebRTC ICE candidate instance
     * @private
     */
    sendIceCandidate(candidate) {
        const localSDP = new SDP(this.peerconnection.localDescription.sdp);

        if (candidate && candidate.candidate.length && !this.lasticecandidate) {
            const ice = SDPUtil.iceparams(localSDP.media[candidate.sdpMLineIndex], localSDP.session);
            const jcand = SDPUtil.candidateToJingle(candidate.candidate);

            if (!(ice && jcand)) {
                const errorMesssage = 'failed to get ice && jcand';

                GlobalOnErrorHandler.callErrorHandler(new Error(errorMesssage));
                logger.error(errorMesssage);

                return;
            }
            ice.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';

            if (this.usedrip) {
                if (this.dripContainer.length === 0) {
                    setTimeout(() => {
                        if (this.dripContainer.length === 0) {
                            return;
                        }
                        this.sendIceCandidates(this.dripContainer);
                        this.dripContainer = [];
                    }, ICE_CAND_GATHERING_TIMEOUT);
                }
                this.dripContainer.push(candidate);
            } else {
                this.sendIceCandidates([candidate]);
            }
        } else {
            logger.log(`${this} sendIceCandidate: last candidate`);

            // FIXME: remember to re-think in ICE-restart
            this.lasticecandidate = true;
        }
    }

    /**
     * Sends given candidates in Jingle 'transport-info' message.
     * @param {Array<RTCIceCandidate>} candidates an array of the WebRTC ICE
     * candidate instances
     * @private
     */
    sendIceCandidates(candidates) {
        if (!this._assertNotEnded('sendIceCandidates')) {

            return;
        }

        logger.log(`${this} sendIceCandidates ${JSON.stringify(candidates)}`);
        const cand = $iq({
            to: this.remoteJid,
            type: 'set'
        })
            .c('jingle', {
                xmlns: 'urn:xmpp:jingle:1',
                action: 'transport-info',
                initiator: this.initiatorJid,
                sid: this.sid
            });

        const localSDP = new SDP(this.peerconnection.localDescription.sdp);

        for (let mid = 0; mid < localSDP.media.length; mid++) {
            const cands = candidates.filter(el => el.sdpMLineIndex === mid);
            const mline
                = SDPUtil.parseMLine(localSDP.media[mid].split('\r\n')[0]);

            if (cands.length > 0) {
                const ice
                    = SDPUtil.iceparams(localSDP.media[mid], localSDP.session);

                ice.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';
                cand.c('content', {
                    creator: this.initiatorJid === this.localJid
                        ? 'initiator' : 'responder',
                    name: cands[0].sdpMid ? cands[0].sdpMid : mline.media
                }).c('transport', ice);
                for (let i = 0; i < cands.length; i++) {
                    const candidate
                        = SDPUtil.candidateToJingle(cands[i].candidate);

                    // Mangle ICE candidate if 'failICE' test option is enabled

                    if (this.failICE) {
                        candidate.ip = '1.1.1.1';
                    }
                    cand.c('candidate', candidate).up();
                }

                // add fingerprint
                const fingerprintLine
                    = SDPUtil.findLine(
                        localSDP.media[mid],
                        'a=fingerprint:', localSDP.session);

                if (fingerprintLine) {
                    const tmp = SDPUtil.parseFingerprint(fingerprintLine);

                    tmp.required = true;
                    cand.c(
                        'fingerprint',
                        { xmlns: 'urn:xmpp:jingle:apps:dtls:0' })
                        .t(tmp.fingerprint);
                    delete tmp.fingerprint;
                    cand.attrs(tmp);
                    cand.up();
                }
                cand.up(); // transport
                cand.up(); // content
            }
        }

        // might merge last-candidate notification into this, but it is called
        // a lot later. See webrtc issue #2340
        // logger.log('was this the last candidate', this.lasticecandidate);
        this.connection.sendIQ(
            cand, null, this.newJingleErrorHandler(cand), IQ_TIMEOUT);
    }

    /**
     * {@inheritDoc}
     */
    addIceCandidates(elem) {
        if (this.peerconnection.signalingState === 'closed') {
            logger.warn(`${this} Ignored add ICE candidate when in closed state`);

            return;
        }

        const iceCandidates = [];

        elem.find('>content>transport>candidate')
            .each((idx, candidate) => {
                let line = SDPUtil.candidateFromJingle(candidate);

                line = line.replace('\r\n', '').replace('a=', '');

                // FIXME this code does not care to handle
                // non-bundle transport
                const rtcCandidate = new RTCIceCandidate({
                    sdpMLineIndex: 0,

                    // FF comes up with more complex names like audio-23423,
                    // Given that it works on both Chrome and FF without
                    // providing it, let's leave it like this for the time
                    // being...
                    // sdpMid: 'audio',
                    sdpMid: '',
                    candidate: line
                });

                iceCandidates.push(rtcCandidate);
            });

        if (!iceCandidates.length) {
            logger.error(`${this} No ICE candidates to add ?`, elem[0] && elem[0].outerHTML);

            return;
        }

        // We want to have this task queued, so that we know it is executed,
        // after the initial sRD/sLD offer/answer cycle was done (based on
        // the assumption that candidates are spawned after the offer/answer
        // and XMPP preserves order).
        const workFunction = finishedCallback => {
            for (const iceCandidate of iceCandidates) {
                this.peerconnection.addIceCandidate(iceCandidate)
                    .then(
                        () => logger.debug(`${this} addIceCandidate ok!`),
                        err => logger.error(`${this} addIceCandidate failed!`, err));
            }

            finishedCallback();
            logger.debug(`${this} ICE candidates task finished`);
        };

        logger.debug(`${this} Queued add (${iceCandidates.length}) ICE candidates task`);
        this.modificationQueue.push(workFunction);
    }

    /**
     *
     * @param contents
     */
    readSsrcInfo(contents) {
        const ssrcs
            = $(contents).find(
                '>description>'
                + 'source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]');

        ssrcs.each((i, ssrcElement) => {
            const ssrc = Number(ssrcElement.getAttribute('ssrc'));

            if (this.isP2P) {
                // In P2P all SSRCs are owner by the remote peer
                this.signalingLayer.setSSRCOwner(
                    ssrc, Strophe.getResourceFromJid(this.remoteJid));
            } else {
                $(ssrcElement)
                    .find('>ssrc-info[xmlns="http://jitsi.org/jitmeet"]')
                    .each((i3, ssrcInfoElement) => {
                        const owner = ssrcInfoElement.getAttribute('owner');

                        if (owner && owner.length) {
                            if (isNaN(ssrc) || ssrc < 0) {
                                logger.warn(`${this} Invalid SSRC ${ssrc} value received for ${owner}`);
                            } else {
                                this.signalingLayer.setSSRCOwner(
                                    ssrc,
                                    Strophe.getResourceFromJid(owner));
                            }
                        }
                    });
            }
        });
    }

    /**
     * Makes the underlying TraceablePeerConnection generate new SSRC for
     * the recvonly video stream.
     * @deprecated
     */
    generateRecvonlySsrc() {
        if (this.peerconnection) {
            this.peerconnection.generateRecvonlySsrc();
        } else {
            logger.error(`${this} Unable to generate recvonly SSRC - no peerconnection`);
        }
    }

    /**
     * Returns the video codec configured as the preferred codec on the peerconnection.
     */
    getConfiguredVideoCodec() {
        return this.peerconnection.getConfiguredVideoCodec();
    }

    /* eslint-disable max-params */
    /**
     * Accepts incoming Jingle 'session-initiate' and should send
     * 'session-accept' in result.
     * @param jingleOffer jQuery selector pointing to the jingle element of
     * the offer IQ
     * @param success callback called when we accept incoming session
     * successfully and receive RESULT packet to 'session-accept' sent.
     * @param failure function(error) called if for any reason we fail to accept
     * the incoming offer. 'error' argument can be used to log some details
     * about the error.
     * @param {Array<JitsiLocalTrack>} [localTracks] the optional list of
     * the local tracks that will be added, before the offer/answer cycle
     * executes. We allow the localTracks to optionally be passed in so that
     * the addition of the local tracks and the processing of the initial offer
     * can all be done atomically. We want to make sure that any other
     * operations which originate in the XMPP Jingle messages related with
     * this session to be executed with an assumption that the initial
     * offer/answer cycle has been executed already.
     */
    acceptOffer(jingleOffer, success, failure, localTracks) {
        this.setOfferAnswerCycle(
            jingleOffer,
            () => {
                // FIXME we may not care about RESULT packet for session-accept
                // then we should either call 'success' here immediately or
                // modify sendSessionAccept method to do that
                this.sendSessionAccept(success, failure);
            },
            failure,
            localTracks);
    }

    /* eslint-enable max-params */

    /**
     * Creates an offer and sends Jingle 'session-initiate' to the remote peer.
     * @param {Array<JitsiLocalTrack>} localTracks the local tracks that will be
     * added, before the offer/answer cycle executes (for the local track
     * addition to be an atomic operation together with the offer/answer).
     */
    invite(localTracks = []) {
        if (!this.isInitiator) {
            throw new Error('Trying to invite from the responder session');
        }
        const workFunction = finishedCallback => {
            const addTracks = [];

            for (const localTrack of localTracks) {
                addTracks.push(this.peerconnection.addTrack(localTrack, this.isInitiator));
            }

            Promise.all(addTracks)
                .then(() => this.peerconnection.createOffer(this.mediaConstraints))
                .then(offerSdp => this.peerconnection.setLocalDescription(offerSdp))
                .then(() => {
                    // NOTE that the offer is obtained from the localDescription getter as it needs to go though
                    // the transformation chain.
                    this.sendSessionInitiate(this.peerconnection.localDescription.sdp);
                })
                .then(() => finishedCallback(), error => finishedCallback(error));
        };

        logger.debug(`${this} Queued invite task`);
        this.modificationQueue.push(
            workFunction,
            error => {
                if (error) {
                    logger.error(`${this} invite error`, error);
                } else {
                    logger.debug(`${this} invite executed - OK`);
                }
            });
    }

    /**
     * Sends 'session-initiate' to the remote peer.
     *
     * NOTE this method is synchronous and we're not waiting for the RESULT
     * response which would delay the startup process.
     *
     * @param {string} offerSdp  - The local session description which will be
     * used to generate an offer.
     * @private
     */
    sendSessionInitiate(offerSdp) {
        let init = $iq({
            to: this.remoteJid,
            type: 'set'
        }).c('jingle', {
            xmlns: 'urn:xmpp:jingle:1',
            action: 'session-initiate',
            initiator: this.initiatorJid,
            sid: this.sid
        });

        new SDP(offerSdp).toJingle(
            init,
            this.isInitiator ? 'initiator' : 'responder');
        init = init.tree();
        logger.info(`${this} Session-initiate: `, init);
        this.connection.sendIQ(init,
            () => {
                logger.info(`${this} Got RESULT for "session-initiate"`);
            },
            error => {
                logger.error(`${this} "session-initiate" error`, error);
            },
            IQ_TIMEOUT);
    }

    /**
     * Sets the answer received from the remote peer.
     * @param jingleAnswer
     */
    setAnswer(jingleAnswer) {
        if (!this.isInitiator) {
            throw new Error('Trying to set an answer on the responder session');
        }
        this.setOfferAnswerCycle(
            jingleAnswer,
            () => {
            },
            error => {
            });
    }

    /* eslint-disable max-params */
    /**
     * This is a setRemoteDescription/setLocalDescription cycle which starts at
     * converting Strophe Jingle IQ into remote offer SDP. Once converted
     * setRemoteDescription, createAnswer and setLocalDescription calls follow.
     * @param jingleOfferAnswerIq jQuery selector pointing to the jingle element
     *        of the offer (or answer) IQ
     * @param success callback called when sRD/sLD cycle finishes successfully.
     * @param failure callback called with an error object as an argument if we
     *        fail at any point during setRD, createAnswer, setLD.
     * @param {Array<JitsiLocalTrack>} [localTracks] the optional list of
     * the local tracks that will be added, before the offer/answer cycle
     * executes (for the local track addition to be an atomic operation together
     * with the offer/answer).
     */
    setOfferAnswerCycle(jingleOfferAnswerIq, success, failure, localTracks = []) {
        const workFunction = finishedCallback => {
            const addTracks = [];

            for (const track of localTracks) {
                addTracks.push(this.peerconnection.addTrack(track, this.isInitiator));
            }

            const newRemoteSdp
                = this._processNewJingleOfferIq(jingleOfferAnswerIq);
            const oldLocalSdp
                = this.peerconnection.localDescription.sdp;

            const bridgeSession
                = $(jingleOfferAnswerIq)
                    .find('>bridge-session['
                        + 'xmlns="http://jitsi.org/protocol/focus"]');
            const bridgeSessionId = bridgeSession.attr('id');

            if (bridgeSessionId !== this._bridgeSessionId) {
                this._bridgeSessionId = bridgeSessionId;
            }

            Promise.all(addTracks)
                .then(() => this._renegotiate(newRemoteSdp.raw))
                .then(() => {
                    if (this.state === JingleSessionState.PENDING) {
                        this.state = JingleSessionState.ACTIVE;

                        // #1 Sync up video transfer active/inactive only after
                        // the initial O/A cycle. We want to adjust the video
                        // media direction only in the local SDP and the Jingle
                        // contents direction included in the initial
                        // offer/answer is mapped to the remote SDP. Jingle
                        // 'content-modify' IQ is processed in a way that it
                        // will only modify local SDP when remote peer is no
                        // longer interested in receiving video content.
                        // Changing media direction in the remote SDP will mess
                        // up our SDP translation chain (simulcast, video mute,
                        // RTX etc.)
                        //
                        // #2 Sends the max frame height if it was set, before the session-initiate/accept
                        if (this.isP2P
                            && (!this._localVideoActive || this.localRecvMaxFrameHeight)) {
                            this.sendContentModify();
                        }
                    }
                })
                .then(() => finishedCallback(), error => finishedCallback(error));
        };

        this.modificationQueue.push(
            workFunction,
            error => {
                if (error) {
                    failure(error);
                } else {
                    success();
                }
            });
    }

    /**
     * Updates the codecs on the peerconnection and initiates a renegotiation for the
     * new codec config to take effect.
     *
     * @param {CodecMimeType} preferred the preferred codec.
     * @param {CodecMimeType} disabled the codec that needs to be disabled.
     */
    setVideoCodecs(preferred = null, disabled = null) {
        const current = this.peerconnection.getConfiguredVideoCodec();

        if (this._assertNotEnded() && preferred !== current) {
            logger.info(`${this} Switching video codec from ${current} to ${preferred}`);
            this.peerconnection.setVideoCodecs(preferred, disabled);

            // Initiate a renegotiate for the codec setting to take effect.
            const workFunction = finishedCallback => {
                this._renegotiate().then(
                    () => {
                        return finishedCallback();
                    }, error => {
                        return finishedCallback(error);
                    });
            };
            // Queue and execute
            this.modificationQueue.push(workFunction);
        }
    }

    /**
     * Sends Jingle 'session-accept' message.
     * @param {function()} success callback called when we receive 'RESULT'
     *        packet for the 'session-accept'
     * @param {function(error)} failure called when we receive an error response
     *        or when the request has timed out.
     * @private
     */
    sendSessionAccept(success, failure) {
        // NOTE: since we're just reading from it, we don't need to be within
        //  the modification queue to access the local description
        const localSDP = new SDP(this.peerconnection.localDescription.sdp);
        let accept = $iq({
            to: this.remoteJid,
            type: 'set'
        })
            .c('jingle', {
                xmlns: 'urn:xmpp:jingle:1',
                action: 'session-accept',
                initiator: this.initiatorJid,
                responder: this.responderJid,
                sid: this.sid
            });

        if (this.webrtcIceTcpDisable) {
            localSDP.removeTcpCandidates = true;
        }
        if (this.webrtcIceUdpDisable) {
            localSDP.removeUdpCandidates = true;
        }
        if (this.failICE) {
            localSDP.failICE = true;
        }
        localSDP.toJingle(
            accept,
            this.initiatorJid === this.localJid ? 'initiator' : 'responder');

        // Calling tree() to print something useful
        accept = accept.tree();
        logger.info(`${this} Sending session-accept`, accept);
        this.connection.sendIQ(accept,
            success,
            this.newJingleErrorHandler(accept, error => {
                failure(error);

                // 'session-accept' is a critical timeout and we'll
                // have to restart
                this.room.eventEmitter.emit(
                    XMPPEvents.SESSION_ACCEPT_TIMEOUT, this);
            }),
            IQ_TIMEOUT);

        // XXX Videobridge needs WebRTC's answer (ICE ufrag and pwd, DTLS
        // fingerprint and setup) ASAP in order to start the connection
        // establishment.
        //
        // FIXME Flushing the connection at this point triggers an issue with
        // BOSH request handling in Prosody on slow connections.
        //
        // The problem is that this request will be quite large and it may take
        // time before it reaches Prosody. In the meantime Strophe may decide
        // to send the next one. And it was observed that a small request with
        // 'transport-info' usually follows this one. It does reach Prosody
        // before the previous one was completely received. 'rid' on the server
        // is increased and Prosody ignores the request with 'session-accept'.
        // It will never reach Jicofo and everything in the request table is
        // lost. Removing the flush does not guarantee it will never happen, but
        // makes it much less likely('transport-info' is bundled with
        // 'session-accept' and any immediate requests).
        //
        // this.connection.flush();
    }

    /**
     * Will send 'content-modify' IQ in order to ask the remote peer to
     * either stop or resume sending video media or to adjust sender's video constraints.
     * @private
     */
    sendContentModify() {
        const maxFrameHeight = this.localRecvMaxFrameHeight;
        const senders = this._localVideoActive ? 'both' : 'none';

        let sessionModify
            = $iq({
                to: this.remoteJid,
                type: 'set'
            })
                .c('jingle', {
                    xmlns: 'urn:xmpp:jingle:1',
                    action: 'content-modify',
                    initiator: this.initiatorJid,
                    sid: this.sid
                })
                .c('content', {
                    name: 'video',
                    senders
                });

        if (typeof maxFrameHeight !== 'undefined') {
            sessionModify = sessionModify
                .c('max-frame-height', { xmlns: 'http://jitsi.org/jitmeet/video' })
                .t(maxFrameHeight);
        }

        logger.info(`${this} sending content-modify, video senders: ${senders}, max frame height: ${maxFrameHeight}`);

        this.connection.sendIQ(
            sessionModify,
            null,
            this.newJingleErrorHandler(sessionModify),
            IQ_TIMEOUT);
    }

    /**
     * Adjust the preference for max video frame height that the local party is willing to receive. Signals
     * the remote party.
     *
     * @param {Number} maxFrameHeight - the new value to set.
     */
    setReceiverVideoConstraint(maxFrameHeight) {
        logger.info(`${this} setReceiverVideoConstraint - max frame height: ${maxFrameHeight}`);

        this.localRecvMaxFrameHeight = maxFrameHeight;

        if (this.isP2P) {
            // Tell the remote peer about our receive constraint. If Jingle session is not yet active the state will
            // be synced after offer/answer.
            if (this.state === JingleSessionState.ACTIVE) {
                this.sendContentModify();
            }
        } else {
            this.rtc.setReceiverVideoConstraint(maxFrameHeight);
        }
    }
    /**
     * Sets the resolution constraint on the local camera track.
     * @param {number} maxFrameHeight - The user preferred max frame height.
     * @returns {Promise} promise that will be resolved when the operation is
     * successful and rejected otherwise.
     */
    setSenderVideoConstraint(maxFrameHeight) {
        if (this._assertNotEnded()) {
            return this.peerconnection.setSenderVideoConstraint(maxFrameHeight);
        }
        return Promise.resolve();
    }

    /**
     * Sets the degradation preference on the video sender. This setting determines if
     * resolution or framerate will be preferred when bandwidth or cpu is constrained.
     * @returns {Promise<void>} promise that will be resolved when the operation is
     * successful and rejected otherwise.
     */
    setSenderVideoDegradationPreference() {
        if (this._assertNotEnded()) {
            return this.peerconnection.setSenderVideoDegradationPreference();
        }

        return Promise.resolve();
    }
    /**
     * Handles XMPP connection state changes.
     *
     * @param {XmppConnection.Status} status - The new status.
     */
    onXmppStatusChanged(status) {
        if (status === XmppConnection.Status.CONNECTED && this._cachedOldLocalSdp) {
            logger.info(`${this} Sending SSRC update on reconnect`);
        }
    }

    /**
     * Takes in a jingle offer iq, returns the new sdp offer
     * @param {jquery xml element} offerIq the incoming offer
     * @returns {SDP object} the jingle offer translated to SDP
     */
    _processNewJingleOfferIq(offerIq) {
        const remoteSdp = new SDP('');

        if (this.webrtcIceTcpDisable) {
            remoteSdp.removeTcpCandidates = true;
        }
        if (this.webrtcIceUdpDisable) {
            remoteSdp.removeUdpCandidates = true;
        }
        if (this.failICE) {
            remoteSdp.failICE = true;
        }

        remoteSdp.fromJingle(offerIq);
        this.readSsrcInfo($(offerIq).find('>content'));

        return remoteSdp;
    }

    /**
     * Do a new o/a flow using the existing remote description
     * @param {string} [optionalRemoteSdp] optional, raw remote sdp
     *  to use.  If not provided, the remote sdp from the
     *  peerconnection will be used
     * @returns {Promise} promise which resolves when the
     *  o/a flow is complete with no arguments or
     *  rejects with an error {string}
     */
    _renegotiate(optionalRemoteSdp) {
        if (this.peerconnection.signalingState === 'closed') {
            const error = new Error('Attempted to renegotiate in state closed');

            this.room.eventEmitter.emit(XMPPEvents.RENEGOTIATION_FAILED, error, this);

            return Promise.reject(error);
        }

        const remoteSdp
            = optionalRemoteSdp || this.peerconnection.remoteDescription.sdp;

        if (!remoteSdp) {
            const error = new Error(`Can not renegotiate without remote description, current state: ${this.state}`);

            this.room.eventEmitter.emit(XMPPEvents.RENEGOTIATION_FAILED, error, this);

            return Promise.reject(error);
        }

        const remoteDescription = new RTCSessionDescription({
            type: this.isInitiator ? 'answer' : 'offer',
            sdp: remoteSdp
        });

        if (this.isInitiator) {
            return this._initiatorRenegotiate(remoteDescription);
        }

        return this._responderRenegotiate(remoteDescription);
    }

    /**
     * Renegotiate cycle implementation for the responder case.
     * @param {object} remoteDescription the SDP object as defined by the WebRTC
     * which will be used as remote description in the cycle.
     * @private
     */
    _responderRenegotiate(remoteDescription) {
        logger.debug(`${this} Renegotiate: setting remote description`);

        return this.peerconnection.setRemoteDescription(remoteDescription)
            .then(() => {
                logger.debug(`${this} Renegotiate: creating answer`);

                return this.peerconnection.createAnswer(this.mediaConstraints)
                    .then(answer => {
                        logger.debug(`${this} Renegotiate: setting local description`);

                        return this.peerconnection.setLocalDescription(answer);
                    });
            });
    }

    /**
     * Renegotiate cycle implementation for the initiator's case.
     * @param {object} remoteDescription the SDP object as defined by the WebRTC
     * which will be used as remote description in the cycle.
     * @private
     */
    _initiatorRenegotiate(remoteDescription) {
        logger.debug(`${this} Renegotiate: creating offer`);

        return this.peerconnection.createOffer(this.mediaConstraints)
            .then(offer => {
                logger.debug(`${this} Renegotiate: setting local description`);

                return this.peerconnection.setLocalDescription(offer)
                    .then(() => {
                        logger.debug(`${this} Renegotiate: setting remote description`);

                        // eslint-disable-next-line max-len
                        return this.peerconnection.setRemoteDescription(remoteDescription);
                    });
            });
    }

    /**
     * Replaces <tt>oldTrack</tt> with <tt>newTrack</tt> and performs a single
     * offer/answer cycle after both operations are done. Either
     * <tt>oldTrack</tt> or <tt>newTrack</tt> can be null; replacing a valid
     * <tt>oldTrack</tt> with a null <tt>newTrack</tt> effectively just removes
     * <tt>oldTrack</tt>
     * @param {JitsiLocalTrack|null} oldTrack the current track in use to be
     * replaced
     * @param {JitsiLocalTrack|null} newTrack the new track to use
     * @returns {Promise} which resolves once the replacement is complete
     *  with no arguments or rejects with an error {string}
     */
    replaceTrack(oldTrack, newTrack) {
        const workFunction = finishedCallback => {
            logger.debug(`${this} replaceTrack worker started. oldTrack = ${oldTrack}, newTrack = ${newTrack}`);

            const oldLocalSdp = this.peerconnection.localDescription.sdp;

            if (!this.usesUnifiedPlan) {
                // NOTE the code below assumes that no more than 1 video track
                // can be added to the peer connection.
                // Transition from camera to desktop share
                // or transition from one camera source to another.
                if (this.peerconnection.options.capScreenshareBitrate
                    && oldTrack && newTrack && newTrack.isVideoTrack()) {
                    // Clearing current primary SSRC will make
                    // the SdpConsistency generate a new one which will result
                    // with:
                    // 1. source-remove for the old video stream.
                    // 2. source-add for the new video stream.
                    this.peerconnection.clearRecvonlySsrc();
                }

                // Transition from no video to video (unmute).
                if (!oldTrack && newTrack && newTrack.isVideoTrack()) {
                    // Clearing current primary SSRC will make
                    // the SdpConsistency generate a new one which will result
                    // with:
                    // 1. source-remove for the recvonly
                    // 2. source-add for the new video stream
                    this.peerconnection.clearRecvonlySsrc();

                    // Transition from video to no video
                } else if (oldTrack && oldTrack.isVideoTrack() && !newTrack) {
                    // Clearing current primary SSRC and generating the recvonly
                    // will result in:
                    // 1. source-remove for the old video stream
                    // 2. source-add for the recvonly stream
                    this.peerconnection.clearRecvonlySsrc();
                    this.peerconnection.generateRecvonlySsrc();
                }
            }

            this.peerconnection.replaceTrack(oldTrack, newTrack)
                .then(shouldRenegotiate => {
                    let promise = Promise.resolve();

                    logger.debug(`${this} TPC.replaceTrack finished. shouldRenegotiate = ${shouldRenegotiate}, JingleSessionState = ${this.state}`);

                    if (shouldRenegotiate
                        && (oldTrack || newTrack)
                        && this.state === JingleSessionState.ACTIVE) {
                        promise = this._renegotiate().then(() => {
                            const newLocalSDP = new SDP(this.peerconnection.localDescription.sdp);
                        });
                    }

                    return promise.then(() => {
                        if (newTrack && newTrack.isVideoTrack()) {
                            logger.debug(`${this} replaceTrack worker: configuring video stream`);

                            // FIXME set all sender parameters in one go?
                            // Set the degradation preference on the new video sender.
                            return this.peerconnection.setSenderVideoDegradationPreference()
                                .then(() => this.peerconnection.setSenderVideoConstraint())
                                .then(() => this.peerconnection.setMaxBitRate());
                        }
                    });
                })
                .then(() => finishedCallback(), error => finishedCallback(error));
        };

        return new Promise((resolve, reject) => {
            logger.debug(`${this} Queued replaceTrack task. Old track = ${oldTrack}, new track = ${newTrack}`);

            this.modificationQueue.push(
                workFunction,
                error => {
                    if (error) {
                        logger.error(`${this} Replace track error:`, error);
                        reject(error);
                    } else {
                        logger.info(`${this}  Replace track done!`);
                        resolve();
                    }
                });
        });
    }

    /**
     * Method returns function(errorResponse) which is a callback to be passed
     * to Strophe connection.sendIQ method. An 'error' structure is created that
     * is passed as 1st argument to given <tt>failureCb</tt>. The format of this
     * structure is as follows:
     * {
     *  code: {XMPP error response code}
     *  reason: {the name of XMPP error reason element or 'timeout' if the
      *          request has timed out within <tt>IQ_TIMEOUT</tt> milliseconds}
     *  source: {request.tree() that provides original request}
     *  session: {this JingleSessionPC.toString()}
     * }
     * @param request Strophe IQ instance which is the request to be dumped into
     *        the error structure
     * @param failureCb function(error) called when error response was returned
     *        or when a timeout has occurred.
     * @returns {function(this:JingleSessionPC)}
     */
    newJingleErrorHandler(request, failureCb) {
        return errResponse => {

            const error = {};

            // Get XMPP error code and condition(reason)
            const errorElSel = $(errResponse).find('error');

            if (errorElSel.length) {
                error.code = errorElSel.attr('code');
                const errorReasonSel = $(errResponse).find('error :first');

                if (errorReasonSel.length) {
                    error.reason = errorReasonSel[0].tagName;
                }

                const errorMsgSel = errorElSel.find('>text');

                if (errorMsgSel.length) {
                    error.msg = errorMsgSel.text();
                }
            }

            if (!errResponse) {
                error.reason = 'timeout';
            }

            error.session = this.toString();

            if (failureCb) {
                failureCb(error);
            } else if (this.state === JingleSessionState.ENDED
                && error.reason === 'item-not-found') {
                // When remote peer decides to terminate the session, but it
                // still have few messages on the queue for processing,
                // it will first send us 'session-terminate' (we enter ENDED)
                // and then follow with 'item-not-found' for the queued requests
                // We don't want to have that logged on error level.
                logger.debug(`${this} Jingle error: ${JSON.stringify(error)}`);
            } else {
                GlobalOnErrorHandler.callErrorHandler(
                    new Error(
                        `Jingle error: ${JSON.stringify(error)}`));
            }
        };
    }

}
