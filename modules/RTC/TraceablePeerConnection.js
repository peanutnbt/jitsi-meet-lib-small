/* global __filename, RTCSessionDescription */

import { Interop } from '@jitsi/sdp-interop';
import * as MediaType from '../../service/RTC/MediaType';
import RTCEvents from '../../service/RTC/RTCEvents';
import * as VideoType from '../../service/RTC/VideoType';
import LocalSdpMunger from '../sdp/LocalSdpMunger';
import SDP from '../sdp/SDP';
import SDPUtil from '../sdp/SDPUtil';

import JitsiRemoteTrack from './JitsiRemoteTrack';
import RTC from './RTC';
import { TPCUtils } from './TPCUtils';

// FIXME SDP tools should end up in some kind of util module

const HD_BITRATE = 2500000;
const LD_BITRATE = 200000;
const SD_BITRATE = 700000;

/* eslint-disable max-params */

/**
 * Creates new instance of 'TraceablePeerConnection'.
 *
 * @param {RTC} rtc the instance of <tt>RTC</tt> service
 * @param {number} id the peer connection id assigned by the parent RTC module.
 * @param {SignalingLayer} signalingLayer the signaling layer instance
 * @param {object} iceConfig WebRTC 'PeerConnection' ICE config
 * @param {object} constraints WebRTC 'PeerConnection' constraints
 * @param {boolean} isP2P indicates whether or not the new instance will be used in a peer to peer connection.
 * @param {object} options <tt>TracablePeerConnection</tt> config options.
 * @param {boolean} options.startSilent If set to 'true' no audio will be sent or received.
 * @param {boolean} options.usesUnifiedPlan Indicates if the  browser is running in unified plan mode.
 *
 * FIXME: initially the purpose of TraceablePeerConnection was to be able to
 * debug the peer connection. Since many other responsibilities have been added
 * it would make sense to extract a separate class from it and come up with
 * a more suitable name.
 *
 * @constructor
 */
export default function TraceablePeerConnection(
    rtc,
    id,
    signalingLayer,
    iceConfig,
    constraints,
    isP2P,
    options) {

    console.log("---------New TraceablePeerConnection--------")
    /**
     * The parent instance of RTC service which created this
     * <tt>TracablePeerConnection</tt>.
     * @type {RTC}
     */
    this.rtc = rtc;

    /**
     * The peer connection identifier assigned by the RTC module.
     * @type {number}
     */
    this.id = id;

    /**
     * Indicates whether or not this instance is used in a peer to peer
     * connection.
     * @type {boolean}
     */
    this.isP2P = isP2P;

    // FIXME: We should support multiple streams per jid.
    /**
     * The map holds remote tracks associated with this peer connection.
     * It maps user's JID to media type and remote track
     * (one track per media type per user's JID).
     * @type {Map<string, Map<MediaType, JitsiRemoteTrack>>}
     */
    this.remoteTracks = new Map();

    /**
     * A map which stores local tracks mapped by {@link JitsiLocalTrack.rtcId}
     * @type {Map<number, JitsiLocalTrack>}
     */
    this.localTracks = new Map();
    /**
     * The local ICE username fragment for this session.
     */
    this.localUfrag = null;

    /**
     * The remote ICE username fragment for this session.
     */
    this.remoteUfrag = null;

    /**
     * The signaling layer which operates this peer connection.
     * @type {SignalingLayer}
     */
    this.signalingLayer = signalingLayer;


    this.options = options;

    // Make sure constraints is properly formatted in order to provide information about whether or not this
    // connection is P2P to rtcstats.
    const safeConstraints = constraints || {};
    safeConstraints.optional = safeConstraints.optional || [];
    this.peerconnection = new RTCPeerConnection(iceConfig, safeConstraints);

    // The standard video bitrates are used in Unified plan when switching
    // between camera/desktop tracks on the same sender.
    const standardVideoBitrates = {
        low: LD_BITRATE,
        standard: SD_BITRATE,
        high: HD_BITRATE
    };

    // Check if the max. bitrates for video are specified through config.js videoQuality settings.
    this.videoBitrates = standardVideoBitrates;

    this.tpcUtils = new TPCUtils(this, this.videoBitrates);

    /**
    * Flag used to indicate if the browser is running in unified  plan mode.
    */
    this._usesUnifiedPlan = options.usesUnifiedPlan;

    this.interop = new Interop();

    /**
     * Munges local SDP provided to the Jingle Session in order to prevent from
     * sending SSRC updates on attach/detach and mute/unmute (for video).
     * @type {LocalSdpMunger}
     */
    this.localSdpMunger = new LocalSdpMunger(this, this.rtc.getLocalEndpointId());

    this.eventEmitter = rtc.eventEmitter;

    this.onicecandidate = null;
    this.peerconnection.onicecandidate = event => {
        if (this.onicecandidate !== null) {
            this.onicecandidate(event);
        }
    };

    // Use track events when browser is running in unified plan mode and stream events in plan-b mode.
    if (this._usesUnifiedPlan) {
        this.onTrack = evt => {
            const stream = evt.streams[0];
            this._remoteTrackAdded(stream, evt.track, evt.transceiver);
        };
        this.peerconnection.addEventListener('track', this.onTrack);
    } 

    this.oniceconnectionstatechange = null;
    this.peerconnection.oniceconnectionstatechange = event => {
        if (this.oniceconnectionstatechange !== null) {
            this.oniceconnectionstatechange(event);
        }
    };

}

/**
 * Called when new remote MediaStream is added to the PeerConnection.
 * @param {MediaStream} stream the WebRTC MediaStream for remote participant
 */
TraceablePeerConnection.prototype._remoteStreamAdded = function (stream) {
    const streamId = stream.id;

    if (!RTC.isUserStreamById(streamId)) {
        return;
    }

    // Call remoteTrackAdded for each track in the stream
    const streamAudioTracks = stream.getAudioTracks();

    for (const audioTrack of streamAudioTracks) {
        this._remoteTrackAdded(stream, audioTrack);
    }
    const streamVideoTracks = stream.getVideoTracks();

    for (const videoTrack of streamVideoTracks) {
        this._remoteTrackAdded(stream, videoTrack);
    }
};


/**
 * Called on "track added" and "stream added" PeerConnection events (because we
 * handle streams on per track basis). Finds the owner and the SSRC for
 * the track and passes that to ChatRoom for further processing.
 * @param {MediaStream} stream the WebRTC MediaStream instance which is
 * the parent of the track
 * @param {MediaStreamTrack} track the WebRTC MediaStreamTrack added for remote
 * participant.
 * @param {RTCRtpTransceiver} transceiver the WebRTC transceiver that is created
 * for the remote participant in unified plan.
 */
TraceablePeerConnection.prototype._remoteTrackAdded = function (stream, track, transceiver = null) {
    const streamId = stream.id;
    const mediaType = track.kind;

    if (!this.isP2P && !RTC.isUserStreamById(streamId)) {
        return;
    }
    // look up an associated JID for a stream id
    if (!mediaType) {
        return;
    }

    const remoteSDP = this._usesUnifiedPlan
        ? new SDP(this.peerconnection.remoteDescription.sdp)
        : new SDP(this.remoteDescription.sdp);
    let mediaLines;

    // In unified plan mode, find the matching mline using 'mid' if its availble, otherwise use the
    // 'msid' attribute of the stream.
    if (this._usesUnifiedPlan) {
        if (transceiver && transceiver.mid) {
            const mid = transceiver.mid;

            mediaLines = remoteSDP.media.filter(mls => SDPUtil.findLine(mls, `a=mid:${mid}`));
        } else {
            mediaLines = remoteSDP.media.filter(mls => {
                const msid = SDPUtil.findLine(mls, 'a=msid:');

                return typeof msid !== 'undefined' && streamId === msid.substring(7).split(' ')[0];
            });
        }
    } 
    if (!mediaLines.length) {
        return;
    }

    let ssrcLines = SDPUtil.findLines(mediaLines[0], 'a=ssrc:');

    ssrcLines = ssrcLines.filter(line => line.indexOf(`msid:${streamId}`) !== -1);
    if (!ssrcLines.length) {
        return;
    }

    // FIXME the length of ssrcLines[0] not verified, but it will fail
    // with global error handler anyway
    const ssrcStr = ssrcLines[0].substring(7).split(' ')[0];
    const trackSsrc = Number(ssrcStr);
    const ownerEndpointId = this.signalingLayer.getSSRCOwner(trackSsrc);

    if (isNaN(trackSsrc) || trackSsrc < 0) {
        return;
    } else if (!ownerEndpointId) {
        return;
    }

    const peerMediaInfo
        = this.signalingLayer.getPeerMediaInfo(ownerEndpointId, mediaType);

    if (!peerMediaInfo) {
        return;
    }

    const muted = peerMediaInfo.muted;
    const videoType = peerMediaInfo.videoType; // can be undefined

    this._createRemoteTrack(ownerEndpointId, stream, track, mediaType, videoType, trackSsrc, muted);
};

// FIXME cleanup params
/* eslint-disable max-params */

/**
 * Initializes a new JitsiRemoteTrack instance with the data provided by
 * the signaling layer and SDP.
 *
 * @param {string} ownerEndpointId the owner's endpoint ID (MUC nickname)
 * @param {MediaStream} stream the WebRTC stream instance
 * @param {MediaStreamTrack} track the WebRTC track instance
 * @param {MediaType} mediaType the track's type of the media
 * @param {VideoType} [videoType] the track's type of the video (if applicable)
 * @param {number} ssrc the track's main SSRC number
 * @param {boolean} muted the initial muted status
 */
TraceablePeerConnection.prototype._createRemoteTrack = function (ownerEndpointId,stream,track, mediaType,videoType,ssrc, muted) {
    let remoteTracksMap = this.remoteTracks.get(ownerEndpointId);

    if (!remoteTracksMap) {
        remoteTracksMap = new Map();
        this.remoteTracks.set(ownerEndpointId, remoteTracksMap);
    }

    const existingTrack = remoteTracksMap.get(mediaType);

    if (existingTrack && existingTrack.getTrack() === track) {
        return;
    } else if (existingTrack) {
    }

    const remoteTrack
        = new JitsiRemoteTrack(this.rtc,this.rtc.conference,ownerEndpointId,stream,track,mediaType,videoType,ssrc,muted,this.isP2P);

    remoteTracksMap.set(mediaType, remoteTrack);
    console.log("---------Emit REMOTE_TRACK_ADDED----------")
    this.eventEmitter.emit(RTCEvents.REMOTE_TRACK_ADDED, remoteTrack, this);
};

const getters = {
    signalingState() {
        return this.peerconnection.signalingState;
    },
    iceConnectionState() {
        return this.peerconnection.iceConnectionState;
    },
    localDescription() {
        let desc = this.peerconnection.localDescription;

        if (!desc) {
            return {};
        }
        // If the browser is running in unified plan mode and this is a jvb connection,
        // transform the SDP to Plan B first.
        if (this._usesUnifiedPlan && !this.isP2P) {
            desc = this.interop.toPlanB(desc);
        }
        // See the method's doc for more info about this transformation.
        desc = this.localSdpMunger.transformStreamIdentifiers(desc);

        return desc;
    },
    remoteDescription() {
        let desc = this.peerconnection.remoteDescription;

        if (!desc) {
            return {};
        }

        if (this._usesUnifiedPlan) {
            desc = this.interop.toPlanB(desc);
        }

        return desc;
    }
};

Object.keys(getters).forEach(prop => {
    Object.defineProperty(
        TraceablePeerConnection.prototype,
        prop, {
        get: getters[prop]
    }
    );
});

/**
 * Add {@link JitsiLocalTrack} to this TPC.
 * @param {JitsiLocalTrack} track
 * @param {boolean} isInitiator indicates if the endpoint is the offerer.
 * @returns {Promise<void>} - resolved when done.
 */
TraceablePeerConnection.prototype.addTrack = function (track, isInitiator = false) {
    const rtcId = track.rtcId;

    if (this.localTracks.has(rtcId)) {
        return Promise.reject(new Error(`${track} is already in ${this}`));
    }

    this.localTracks.set(rtcId, track);

    if (this._usesUnifiedPlan) {
        try {
            this.tpcUtils.addTrack(track, isInitiator);
        } catch (error) {
            return Promise.reject(error);
        }
    }
    let promiseChain = Promise.resolve();
    return promiseChain;
};

TraceablePeerConnection.prototype.setLocalDescription = function (description) {
    let localSdp = description;
    localSdp = this.interop.toUnifiedPlan(localSdp);

    return new Promise((resolve, reject) => {
        this.peerconnection.setLocalDescription(localSdp)
            .then(() => {
                const localUfrag = SDPUtil.getUfrag(localSdp.sdp);

                if (localUfrag !== this.localUfrag) {
                    this.localUfrag = localUfrag;
                    this.eventEmitter.emit(RTCEvents.LOCAL_UFRAG_CHANGED, this, localUfrag);
                }

                resolve();
            }, err => {
                this.eventEmitter.emit(RTCEvents.SET_LOCAL_DESCRIPTION_FAILED, err, this);
                reject(err);
            });
    });
};

TraceablePeerConnection.prototype.setRemoteDescription = function (description) {

    const currentDescription = this.peerconnection.remoteDescription;
    description = this.interop.toUnifiedPlan(description, currentDescription);

    if (this._usesUnifiedPlan) {
        description = this.tpcUtils.ensureCorrectOrderOfSsrcs(description);
    }

    return new Promise((resolve, reject) => {
        this.peerconnection.setRemoteDescription(description)
            .then(() => {
                const remoteUfrag = SDPUtil.getUfrag(description.sdp);

                if (remoteUfrag !== this.remoteUfrag) {
                    this.remoteUfrag = remoteUfrag;
                    this.eventEmitter.emit(RTCEvents.REMOTE_UFRAG_CHANGED, this, remoteUfrag);
                }
                resolve();
            }, err => {
                this.eventEmitter.emit(RTCEvents.SET_REMOTE_DESCRIPTION_FAILED, err, this);
                reject(err);
            });
    });
};

TraceablePeerConnection.prototype.createAnswer = function (constraints) {
    return this._createOfferOrAnswer(false /* answer */, constraints);
};

TraceablePeerConnection.prototype.createOffer = function (constraints) {
    return this._createOfferOrAnswer(true /* offer */, constraints);
};

TraceablePeerConnection.prototype._createOfferOrAnswer = function (
    isOffer,
    constraints) {
    const handleSuccess = (resultSdp, resolveFn, rejectFn) => {
        try {
            resolveFn(resultSdp);
        } catch (e) {
            rejectFn(e);
        }
    };
    const handleFailure = (err, rejectFn) => {
        const eventType = isOffer ? RTCEvents.CREATE_OFFER_FAILED : RTCEvents.CREATE_ANSWER_FAILED;
        this.eventEmitter.emit(eventType, err, this);
        rejectFn(err);
    };

    return new Promise((resolve, reject) => {
        let oaPromise;
        if (isOffer) {
            oaPromise = this.peerconnection.createOffer(constraints);
        } else {
            oaPromise = this.peerconnection.createAnswer(constraints);
        }
        oaPromise.then(sdp => handleSuccess(sdp, resolve, reject), error => handleFailure(error, reject));
    });
};
