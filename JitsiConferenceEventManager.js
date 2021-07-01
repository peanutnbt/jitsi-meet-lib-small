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
    chatRoom.addListener('xmpp.muc_joined',
        () => {
            this.conference._onMucJoined();
            this.conference.isJvbConnectionInterrupted = false;
            // TODO: Move all of the 'connectionTimes' logic to its own module.
            Object.keys(chatRoom.connectionTimes).forEach(key => {
            });
            // TODO: Move all of the 'connectionTimes' logic to its own module.
            Object.keys(chatRoom.xmpp.connectionTimes).forEach(key => {
            });
        });

    chatRoom.addListener('xmpp.muc_member_joined',
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
        'rtc.remote_track_added',
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
        'xmpp.callincoming.jingle',
        conference.onIncomingCall.bind(conference));
    this._addConferenceXMPPListener(
        'xmpp.callaccepted.jingle',
        conference.onCallAccepted.bind(conference));
    this._addConferenceXMPPListener(
        'xmpp.transportinfo.jingle',
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

