import { $iq, Strophe } from 'strophe.js';

import SDP from '../sdp/SDP';
import SDPUtil from '../sdp/SDPUtil';
import AsyncQueue from '../util/AsyncQueue';

import JingleSession from './JingleSession';
import * as JingleSessionState from './JingleSessionState';
import SignalingLayerImpl from './SignalingLayerImpl';
import XmppConnection from './XmppConnection';


/**
 * Constant tells how long we're going to wait for IQ response, before timeout
 * error is  triggered.
 * @type {number}
 */
const IQ_TIMEOUT = 10000;

/**
 * The time duration for which the client keeps gathering ICE candidates to be sent out in a single IQ.
 * @type {number} timeout in ms.
 */
const ICE_CAND_GATHERING_TIMEOUT = 150;

/**
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
 */
/**
 *
 */
export default class JingleSessionPC extends JingleSession {
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
                () => { })
        );
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

    doInitialize(options) {
        console.log("----------Jingle Session doInitialize-----------")

        this.failICE = Boolean(options.failICE);
        this.lasticecandidate = false;
        this.options = options;

        this.isReconnect = false;

        this.wasstable = false;
        this.webrtcIceUdpDisable = Boolean(options.webrtcIceUdpDisable);
        this.webrtcIceTcpDisable = Boolean(options.webrtcIceTcpDisable);

        this.peerconnection
            = this.rtc.createPeerConnection(
                this.signalingLayer,
                this.iceConfig,
                this.isP2P,
                { usesUnifiedPlan: true });

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
        /**
         * The oniceconnectionstatechange event handler contains the code to
         * execute when the iceconnectionstatechange event, of type Event,
         * is received by this RTCPeerConnection. Such an event is sent when
         * the value of RTCPeerConnection.iceConnectionState changes.
         */
        this.peerconnection.oniceconnectionstatechange = () => {
            const now = window.performance.now();
            let isStable = false;
            this.room.eventEmitter.emit('xmpp.ice_connection_state_changed',this,this.peerconnection.iceConnectionState);
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
                            this.room.eventEmitter.emit('xmpp.connection.restored', this);
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
                            || (this.usesUnifiedPlan && this.isInitiator))) {

                        // Switch between ICE gathering and ICE checking whichever
                        // started first (scenarios are different for initiator
                        // vs responder)
                        const iceStarted = Math.min(this._iceCheckingStartedTimestamp, this._gatheringStartedTimestamp);
                        this.establishmentDuration = now - iceStarted;
                        this.wasConnected = true;
                        this.room.eventEmitter.emit('xmpp.connection.connected', this);
                    }
                    this.isReconnect = false;
                    break;
            }
        };
        // The signaling layer will bind it's listeners at this point
        this.signalingLayer.setChatRoom(this.room);
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
        this.connection.sendIQ(cand, null, this.newJingleErrorHandler(cand), IQ_TIMEOUT);
    }

    addIceCandidates(elem) {
        if (this.peerconnection.signalingState === 'closed') {
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
            return;
        }

        // We want to have this task queued, so that we know it is executed,
        // after the initial sRD/sLD offer/answer cycle was done (based on
        // the assumption that candidates are spawned after the offer/answer
        // and XMPP preserves order).
        const workFunction = finishedCallback => {
            for (const iceCandidate of iceCandidates) {
                this.peerconnection.addIceCandidate(iceCandidate)
                    .then(() => {},err => {});
            }
            finishedCallback();
        };

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
     */
    acceptOffer(jingleOffer, success, failure) {
        this.setOfferAnswerCycle(
            jingleOffer,
            () => {
                // FIXME we may not care about RESULT packet for session-accept
                // then we should either call 'success' here immediately or
                // modify sendSessionAccept method to do that
                this.sendSessionAccept(success, failure);
            },
            failure);
    }
  
    /**
     * Sets the answer received from the remote peer.
     * @param jingleAnswer
     */
    setAnswer(jingleAnswer) {
        if (!this.isInitiator) {
            throw new Error('Trying to set an answer on the responder session');
        }
        this.setOfferAnswerCycle(jingleAnswer,() => {},error => {});
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
     */
    setOfferAnswerCycle(jingleOfferAnswerIq, success, failure) {
        const workFunction = finishedCallback => {
            const addTracks = [];

            const newRemoteSdp
                = this._processNewJingleOfferIq(jingleOfferAnswerIq);

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
        this.connection.sendIQ(accept,
            success,
            this.newJingleErrorHandler(accept, error => {
                failure(error);

                // 'session-accept' is a critical timeout and we'll
                // have to restart
                this.room.eventEmitter.emit('xmpp.session_accept_timeout', this);
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
            this.room.eventEmitter.emit('xmpp.renegotiation_failed', error, this);
            return Promise.reject(error);
        }

        const remoteSdp = optionalRemoteSdp || this.peerconnection.remoteDescription.sdp;

        if (!remoteSdp) {
            const error = new Error(`Can not renegotiate without remote description, current state: ${this.state}`);
            this.room.eventEmitter.emit('xmpp.renegotiation_failed', error, this);
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
        return this.peerconnection.setRemoteDescription(remoteDescription)
            .then(() => {
                return this.peerconnection.createAnswer(this.mediaConstraints)
                    .then(answer => {
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
        return this.peerconnection.createOffer(this.mediaConstraints)
            .then(offer => {
                return this.peerconnection.setLocalDescription(offer)
                    .then(() => {
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

            this.peerconnection.replaceTrack(oldTrack, newTrack)
                .then(shouldRenegotiate => {
                    let promise = Promise.resolve();
                    if (shouldRenegotiate
                        && (oldTrack || newTrack)
                        && this.state === JingleSessionState.ACTIVE) {
                        promise = this._renegotiate().then(() => {
                            const newLocalSDP = new SDP(this.peerconnection.localDescription.sdp);
                        });
                    }

                    return promise.then(() => {
                        if (newTrack && newTrack.isVideoTrack()) {
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
            this.modificationQueue.push(
                workFunction,
                error => {
                    if (error) {
                        reject(error);
                    } else {
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
            }
        };
    }

}
