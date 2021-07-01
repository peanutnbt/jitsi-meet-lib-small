/* global __filename */

import { getLogger } from 'jitsi-meet-logger';
import { Strophe } from 'strophe.js';

import * as JitsiConferenceErrors from './JitsiConferenceErrors';
import * as JitsiConferenceEvents from './JitsiConferenceEvents';
import { SPEAKERS_AUDIO_LEVELS } from './modules/statistics/constants';
import Statistics from './modules/statistics/statistics';
import EventEmitterForwarder from './modules/util/EventEmitterForwarder';
import * as MediaType from './service/RTC/MediaType';
import RTCEvents from './service/RTC/RTCEvents';
import VideoType from './service/RTC/VideoType';
import AuthenticationEvents
    from './service/authentication/AuthenticationEvents';
import {
    ACTION_JINGLE_SA_TIMEOUT,
    createBridgeDownEvent,
    createConnectionStageReachedEvent,
    createFocusLeftEvent,
    createJingleEvent,
    createRemotelyMutedEvent
} from './service/statistics/AnalyticsEvents';
import XMPPEvents from './service/xmpp/XMPPEvents';

const logger = getLogger(__filename);

/**
 * Setups all event listeners related to conference
 * @param conference {JitsiConference} the conference
 */
export default function JitsiConferenceEventManager(conference) {
    this.conference = conference;
    this.xmppListeners = {};
}

/**
 * Setups event listeners related to conference.chatRoom
 */
JitsiConferenceEventManager.prototype.setupChatRoomListeners = function() {
    console.log("----------Setup Chat Room Listeners---------")
    const conference = this.conference;
    const chatRoom = conference.room;
    // send some analytics events
    chatRoom.addListener(XMPPEvents.MUC_JOINED,
        () => {
            this.conference._onMucJoined();
            this.conference.isJvbConnectionInterrupted = false;
            // TODO: Move all of the 'connectionTimes' logic to its own module.
            Object.keys(chatRoom.connectionTimes).forEach(key => {
                const event
                    = createConnectionStageReachedEvent(
                        `conference_${key}`,
                        { value: chatRoom.connectionTimes[key] });

                Statistics.sendAnalytics(event);
            });
            // TODO: Move all of the 'connectionTimes' logic to its own module.
            Object.keys(chatRoom.xmpp.connectionTimes).forEach(key => {
                const event
                    = createConnectionStageReachedEvent(
                        `xmpp_${key}`,
                        { value: chatRoom.xmpp.connectionTimes[key] });

                Statistics.sendAnalytics(event);
            });
        });

    chatRoom.addListener(XMPPEvents.MUC_MEMBER_JOINED,
        conference.onMemberJoined.bind(conference));
};

/**
 * Setups event listeners related to conference.rtc
 */
JitsiConferenceEventManager.prototype.setupRTCListeners = function() {
    console.log("----------Setup RTC Listeners---------")
    const conference = this.conference;
    const rtc = conference.rtc;

    rtc.addListener(
        RTCEvents.REMOTE_TRACK_ADDED,
        conference.onRemoteTrackAdded.bind(conference));

};

/**
 * Removes event listeners related to conference.xmpp
 */
JitsiConferenceEventManager.prototype.removeXMPPListeners = function() {
    const conference = this.conference;

    Object.keys(this.xmppListeners).forEach(eventName => {
        conference.xmpp.removeListener(
            eventName,
            this.xmppListeners[eventName]);
    });
    this.xmppListeners = {};
};


/**
 * Setups event listeners related to conference.xmpp
 */
JitsiConferenceEventManager.prototype.setupXMPPListeners = function() {
    console.log("----------Setup XMPP Listeners---------")
    const conference = this.conference;

    this._addConferenceXMPPListener(
        XMPPEvents.CALL_INCOMING,
        conference.onIncomingCall.bind(conference));
    this._addConferenceXMPPListener(
        XMPPEvents.CALL_ACCEPTED,
        conference.onCallAccepted.bind(conference));
    this._addConferenceXMPPListener(
        XMPPEvents.TRANSPORT_INFO,
        conference.onTransportInfo.bind(conference));
};

/**
 * Add XMPP listener and save its reference for remove on leave conference.
 */
JitsiConferenceEventManager.prototype._addConferenceXMPPListener = function(
        eventName, listener) {
    this.xmppListeners[eventName] = listener;
    this.conference.xmpp.addListener(eventName, listener);
};

