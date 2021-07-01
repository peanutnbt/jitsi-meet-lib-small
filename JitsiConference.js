import EventEmitter from 'events';
import { Strophe } from 'strophe.js';

import JitsiConferenceEventManager from './JitsiConferenceEventManager';
import JitsiParticipant from './JitsiParticipant';
import RTC from './modules/RTC/RTC';
import {
    FEATURE_JIGASI,
} from './modules/xmpp/xmpp';

/**
 * Creates a JitsiConference object with the given name and properties.
 * Note: this constructor is not a part of the public API (objects should be
 * created using JitsiConnection.createConference).
 * @param options.config properties / settings related to the conference that
 * will be created.
 * @param options.name the name of the conference
 * @param options.connection the JitsiConnection object for this
 * JitsiConference.
 * @param {number} [options.config.avgRtpStatsN=15] how many samples are to be
 * collected by {@link AvgRTPStatsReporter}, before arithmetic mean is
 * calculated and submitted to the analytics module.
 * @param {boolean} [options.config.enableIceRestart=false] - enables the ICE
 * restart logic.
 * @param {boolean} [options.config.p2p.enabled] when set to <tt>true</tt>
 * the peer to peer mode will be enabled. It means that when there are only 2
 * participants in the conference an attempt to make direct connection will be
 * made. If the connection succeeds the conference will stop sending data
 * through the JVB connection and will use the direct one instead.
 * @param {number} [options.config.p2p.backToP2PDelay=5] a delay given in
 * seconds, before the conference switches back to P2P, after the 3rd
 * participant has left the room.
 * @param {number} [options.config.channelLastN=-1] The requested amount of
 * videos are going to be delivered after the value is in effect. Set to -1 for
 * unlimited or all available videos.
 * @param {number} [options.config.forceJVB121Ratio]
 * "Math.random() < forceJVB121Ratio" will determine whether a 2 people
 * conference should be moved to the JVB instead of P2P. The decision is made on
 * the responder side, after ICE succeeds on the P2P connection.
 * @constructor
 */
export default function JitsiConference(options) {
    if (!options.name || options.name.toLowerCase() !== options.name) {
        const errmsg
            = 'Invalid conference name (no conference name passed or it '
            + 'contains invalid characters like capital letters)!';
        throw new Error(errmsg);
    }
    this.eventEmitter = new EventEmitter();
    this.options = options;
    this.eventManager = new JitsiConferenceEventManager(this);
    this.participants = {};
    this._init(options);

    this.jvbJingleSession = null;
    // Conference properties, maintained by jicofo.
    this.properties = {};

    /**
     * Flag set to <tt>true</tt> when P2P session has been established
     * (ICE has been connected) and this conference is currently in the peer to
     * peer mode (P2P connection is the active one).
     * @type {boolean}
     */
    this.p2p = false;
    this.p2pJingleSession = null;

}

// FIXME convert JitsiConference to ES6 - ASAP !
JitsiConference.prototype.constructor = JitsiConference;

/**
 * Initializes the conference object properties
 * @param options {object}
 * @param options.connection {JitsiConnection} overrides this.connection
 */
JitsiConference.prototype._init = function (options = {}) {
    // Override connection and xmpp properties (Useful if the connection
    // reloaded)
    if (options.connection) {
        this.connection = options.connection;
        this.xmpp = this.connection.xmpp;
        // Setup XMPP events only if we have new connection object.
        this.eventManager.setupXMPPListeners();
    }
    const { config } = this.options;
    this.room = this.xmpp.createRoom(this.options.name, { ...config });
    if (!this.rtc) {
        console.log("----------Create New RTC---------")
        this.rtc = new RTC(this, options);
        this.eventManager.setupRTCListeners();
    }

    this.eventManager.setupChatRoomListeners();
};

/**
 * Joins the conference.
 * @param password {string} the password
 * @param replaceParticipant {boolean} whether the current join replaces
 * an existing participant with same jwt from the meeting.
 */
JitsiConference.prototype.join = function (password, replaceParticipant = false) {
    if (this.room) {
        console.log("----------Join Room----------")
        this.room.join(password, replaceParticipant)
    }
};

JitsiConference.prototype.on = function (eventId, handler) {
    if (this.eventEmitter) {
        this.eventEmitter.on(eventId, handler);
    }
};

/**
 * Removes event listener
 * @param eventId the event ID.
 * @param [handler] optional, the specific handler to unbind
 *
 * Note: consider adding eventing functionality by extending an EventEmitter
 * impl, instead of rolling ourselves
 */
JitsiConference.prototype.off = function (eventId, handler) {
    if (this.eventEmitter) {
        this.eventEmitter.removeListener(eventId, handler);
    }
};

// Common aliases for event emitter
JitsiConference.prototype.addEventListener = JitsiConference.prototype.on;
JitsiConference.prototype.removeEventListener = JitsiConference.prototype.off;

/**
 * Replaces oldTrack with newTrack and performs a single offer/answer
 *  cycle after both operations are done.  Either oldTrack or newTrack
 *  can be null; replacing a valid 'oldTrack' with a null 'newTrack'
 *  effectively just removes 'oldTrack'
 * @param {JitsiLocalTrack} oldTrack the current stream in use to be replaced
 * @param {JitsiLocalTrack} newTrack the new stream to use
 * @returns {Promise} resolves when the replacement is finished
 */
JitsiConference.prototype.replaceTrack = function (oldTrack, newTrack) {
    // Now replace the stream at the lower levels
    return this._doReplaceTrack(oldTrack, newTrack)
        .then(() => {
            if (oldTrack) {
                this.onLocalTrackRemoved(oldTrack);
            }

            // Send 'VideoTypeMessage' on the bridge channel for the new track.
            if (newTrack) {
                // Now handle the addition of the newTrack at the JitsiConference level
                this._setupNewTrack(newTrack);
                newTrack.isVideoTrack() && this.rtc.setVideoType(newTrack.getVideoType());
            } else {
                oldTrack && oldTrack.isVideoTrack() && this.rtc.setVideoType('none');
            }


            return Promise.resolve();
        })
        .catch(error => Promise.reject(new Error(error)));
};

/**
 * Replaces the tracks at the lower level by going through the Jingle session
 * and WebRTC peer connection. The method will resolve immediately if there is
 * currently no JingleSession started.
 * @param {JitsiLocalTrack|null} oldTrack the track to be removed during
 * the process or <tt>null</t> if the method should act as "add track"
 * @param {JitsiLocalTrack|null} newTrack the new track to be added or
 * <tt>null</tt> if the method should act as "remove track"
 * @return {Promise} resolved when the process is done or rejected with a string
 * which describes the error.
 * @private
 */
JitsiConference.prototype._doReplaceTrack = function (oldTrack, newTrack) {
    const replaceTrackPromises = [];

    if (this.jvbJingleSession) {
        replaceTrackPromises.push(
            this.jvbJingleSession.replaceTrack(oldTrack, newTrack));
    }

    if (this.p2pJingleSession) {
        replaceTrackPromises.push(
            this.p2pJingleSession.replaceTrack(oldTrack, newTrack));
    }

    return Promise.all(replaceTrackPromises);
};

/**
 * Operations related to creating a new track
 * @param {JitsiLocalTrack} newTrack the new track being created
 */
JitsiConference.prototype._setupNewTrack = function (newTrack) {
    if (newTrack.isAudioTrack() || (newTrack.isVideoTrack()
        && newTrack.videoType !== 'desktop')) {
        // Report active device to statistics
        const devices = RTC.getCurrentlyAvailableMediaDevices();
    }
    this.rtc.addLocalTrack(newTrack);


    newTrack._setConference(this);

    this.eventEmitter.emit('conference.trackAdded', newTrack);
};

/**
 * @return Array<JitsiParticipant> an array of all participants in this
 * conference.
 */
JitsiConference.prototype.getParticipants = function () {
    return Object.values(this.participants);
};
/**
 * @returns {JitsiParticipant} the participant in this conference with the
 * specified id (or undefined if there isn't one).
 * @param id the id of the participant.
 */
JitsiConference.prototype.getParticipantById = function (id) {
    return this.participants[id];
};

/**
 * Notifies this JitsiConference that a new member has joined its chat room.
 *
 * FIXME This should NOT be exposed!
 *
 * @param jid the jid of the participant in the MUC
 * @param nick the display name of the participant
 * @param role the role of the participant in the MUC
 * @param isHidden indicates if this is a hidden participant (system
 * participant for example a recorder).
 * @param statsID the participant statsID (optional)
 * @param status the initial status if any
 * @param identity the member identity, if any
 * @param botType the member botType, if any
 * @param fullJid the member full jid, if any
 * @param features the member botType, if any
 * @param isReplaceParticipant whether this join replaces a participant with
 * the same jwt.
 */
JitsiConference.prototype.onMemberJoined = function (
    jid, nick, role, isHidden, statsID, status, identity, botType, fullJid, features, isReplaceParticipant) {
    const id = Strophe.getResourceFromJid(jid);

    if (id === 'focus' || this.myUserId() === id) {
        return;
    }

    const participant
        = new JitsiParticipant(jid, this, nick, isHidden, statsID, status, identity);

    this.participants[id] = participant;
    console.log("----------Emit User Joined---------")
    this.eventEmitter.emit('conference.userJoined',id,participant);

    // maybeStart only if we had finished joining as then we will have information for the number of participants
    if (this.room && this.room.joined) {
        this._maybeStartOrStopP2P();
    }
};

/**
 * Get notified when we joined the room.
 *
 * FIXME This should NOT be exposed!
 *
 * @private
 */
JitsiConference.prototype._onMucJoined = function () {
    this._maybeStartOrStopP2P();
};

/**
 * Notifies this JitsiConference that a JitsiRemoteTrack was added into
 * the conference.
 *
 * @param {JitsiRemoteTrack} track the JitsiRemoteTrack which was added to this
 * JitsiConference
 */
JitsiConference.prototype.onRemoteTrackAdded = function (track) {
    console.log("---------onRemoteTrackAdded----------")
    if (track.isP2P && !this.isP2PActive()) {
        return;
    } else if (!track.isP2P && this.isP2PActive()) {
        return;
    }

    const id = track.getParticipantId();
    const participant = this.getParticipantById(id);

    if (!participant) {
        return;
    }

    // Add track to JitsiParticipant.
    participant._tracks.push(track);

    if (this.transcriber) {
        this.transcriber.addTrack(track);
    }

    const emitter = this.eventEmitter;

    emitter.emit('conference.trackAdded', track);
};

/**
 * Callback called by the Jingle plugin when 'session-answer' is received.
 * @param {JingleSessionPC} session the Jingle session for which an answer was
 * received.
 * @param {jQuery} answer a jQuery selector pointing to 'jingle' IQ element
 */
// eslint-disable-next-line no-unused-vars
JitsiConference.prototype.onCallAccepted = function (session, answer) {
    if (this.p2pJingleSession === session) {
        this.p2pJingleSession.setAnswer(answer);
        this.eventEmitter.emit('conference.media_session.started', this.p2pJingleSession);
    }
};

/**
 * Callback called by the Jingle plugin when 'transport-info' is received.
 * @param {JingleSessionPC} session the Jingle session for which the IQ was
 * received
 * @param {jQuery} transportInfo a jQuery selector pointing to 'jingle' IQ
 * element
 */
// eslint-disable-next-line no-unused-vars
JitsiConference.prototype.onTransportInfo = function (session, transportInfo) {
    if (this.p2pJingleSession === session) {
        this.p2pJingleSession.addIceCandidates(transportInfo);
    }
};
/**
 * Handles an incoming call event.
 */
JitsiConference.prototype.onIncomingCall = function (jingleSession, jingleOffer, now) {
    console.log("---------On Incoming call---------")
    this._acceptJvbIncomingCall(jingleSession, jingleOffer);
};

/**
 * Accepts an incoming call event for the JVB jingle session.
 */
JitsiConference.prototype._acceptJvbIncomingCall = function (jingleSession,jingleOffer) {

    console.log("----------Accept JVB incoming call----------")
    // Accept incoming call
    this.jvbJingleSession = jingleSession;

    try {
        jingleSession.initialize(this.room, this.rtc, {
            ...this.options.config,
        });
    } catch (error) {
        return;
    }

    jingleSession.acceptOffer(
        jingleOffer,
        () => {

            this.eventEmitter.emit('conference.media_session.started',jingleSession);
            if (!this.isP2PActive()) {
                this.eventEmitter.emit('conference.media_session.active_changed',jingleSession);
            }
        },
        error => { }
    );
};

/**
 * Returns the local user's ID
 * @return {string} local user's ID
 */
JitsiConference.prototype.myUserId = function () {
    return (
        this.room && this.room.myroomjid
            ? Strophe.getResourceFromJid(this.room.myroomjid)
            : null);
};
/**
 * Handles track attached to container (Calls associateStreamWithVideoTag method
 * from statistics module)
 * @param {JitsiLocalTrack|JitsiRemoteTrack} track the track
 * @param container the container
 */
JitsiConference.prototype._onTrackAttach = function (track, container) {
    const isLocal = track.isLocal();
    let ssrc = null;
    const isP2P = track.isP2P;
    const remoteUserId = isP2P ? track.getParticipantId() : 'jitsi';
    const peerConnection
        = isP2P
            ? this.p2pJingleSession && this.p2pJingleSession.peerconnection
            : this.jvbJingleSession && this.jvbJingleSession.peerconnection;

    if (isLocal) {
        // Local tracks have SSRC stored on per peer connection basis.
        if (peerConnection) {
            ssrc = peerConnection.getLocalSSRC(track);
        }
    } else {
        ssrc = track.getSSRC();
    }
    if (!container.id || !ssrc || !peerConnection) {
        return;
    }
};

/**
 * Accept incoming P2P Jingle call.
 * @param {JingleSessionPC} jingleSession the session instance
 * @param {jQuery} jingleOffer a jQuery selector pointing to 'jingle' IQ element
 * @private
 */
JitsiConference.prototype._acceptP2PIncomingCall = function (
    jingleSession,
    jingleOffer) {

    console.log("----------Accept P2P incoming call----------")

    // Accept the offer
    this.p2pJingleSession = jingleSession;

    this.p2pJingleSession.initialize(
        this.room,
        this.rtc, {
        ...this.options.config,
    });

    let remoteID = Strophe.getResourceFromJid(this.p2pJingleSession.remoteJid);

    const participant = this.participants[remoteID];

    if (participant) {
        remoteID = participant.getStatsID() || remoteID;
    }


    this.p2pJingleSession.acceptOffer(
        jingleOffer,
        () => {
            this.eventEmitter.emit('conference.media_session.started',this.p2pJingleSession);
        },
        error => { });
};

/**
 * Method when called will decide whether it's the time to start or stop
 * the P2P session.
 * @param {boolean} userLeftEvent if <tt>true</tt> it means that the call
 * originates from the user left event.
 * @private
 */
JitsiConference.prototype._maybeStartOrStopP2P = function (userLeftEvent) {

    const peers = this.getParticipants();
    const peerCount = peers.length;

    // FIXME 1 peer and it must *support* P2P switching
    const shouldBeInP2P = this._shouldBeInP2PMode();

    // Start peer to peer session
    if (!this.p2pJingleSession && shouldBeInP2P) {
        const peer = peerCount && peers[0];


        const myId = this.myUserId();
        const peersId = peer.getId();

        if (myId > peersId) {
            return;
        } else if (myId === peersId) {
            return;
        }

        const jid = peer.getJid();

        this._startP2PSession(jid);
    } else if (this.p2pJingleSession && !shouldBeInP2P) {
        this._stopP2PSession();
    }
};

/**
 * Tells whether or not this conference should be currently in the P2P mode.
 *
 * @private
 * @returns {boolean}
 */
JitsiConference.prototype._shouldBeInP2PMode = function () {
    const peers = this.getParticipants();
    const peerCount = peers.length;
    const hasBotPeer = peers.find(p => p.getBotType() === 'poltergeist' || p.hasFeature(FEATURE_JIGASI)) !== undefined;
    const shouldBeInP2P = peerCount === 1 && !hasBotPeer;

    return shouldBeInP2P;
};

/**
 * Checks whether or not the conference is currently in the peer to peer mode.
 * Being in peer to peer mode means that the direct connection has been
 * established and the P2P connection is being used for media transmission.
 * @return {boolean} <tt>true</tt> if in P2P mode or <tt>false</tt> otherwise.
 */
JitsiConference.prototype.isP2PActive = function () {
    return this.p2p;
};




