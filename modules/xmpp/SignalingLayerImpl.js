/* global __filename */

import { getLogger } from 'jitsi-meet-logger';

import SignalingLayer from './SignalingLayer';

const logger = getLogger(__filename);

/**
 * Default XMPP implementation of the {@link SignalingLayer} interface. Obtains
 * the data from the MUC presence.
 */
export default class SignalingLayerImpl extends SignalingLayer {
    /**
     * Creates new instance.
     */
    constructor() {
        super();

        /**
         * A map that stores SSRCs of remote streams. And is used only locally
         * We store the mapping when jingle is received, and later is used
         * onaddstream webrtc event where we have only the ssrc
         * FIXME: This map got filled and never cleaned and can grow during long
         * conference
         * @type {Map<number, string>} maps SSRC number to jid
         */
        this.ssrcOwners = new Map();

        /**
         *
         * @type {ChatRoom|null}
         */
        this.chatRoom = null;
    }

    /**
     * Sets the <tt>ChatRoom</tt> instance used and binds presence listeners.
     * @param {ChatRoom} room
     */
    setChatRoom(room) {
        const oldChatRoom = this.chatRoom;

        this.chatRoom = room;
        if (oldChatRoom) {
            oldChatRoom.removePresenceListener(
                'audiomuted', this._audioMuteHandler);
            oldChatRoom.removePresenceListener(
                'videomuted', this._videoMuteHandler);
            oldChatRoom.removePresenceListener(
                'videoType', this._videoTypeHandler);
        }
        if (room) {
            this._audioMuteHandler = (node, from) => {
                this.eventEmitter.emit(
                    'signaling.peerMuted',
                    from, 'audio', node.value === 'true');
            };
            room.addPresenceListener('audiomuted', this._audioMuteHandler);

            this._videoMuteHandler = (node, from) => {
                this.eventEmitter.emit(
                    'signaling.peerMuted',
                    from, 'video', node.value === 'true');
            };
            room.addPresenceListener('videomuted', this._videoMuteHandler);

            this._videoTypeHandler = (node, from) => {
                this.eventEmitter.emit(
                    'signaling.peerVideoType',
                    from, node.value);
            };
            room.addPresenceListener('videoType', this._videoTypeHandler);
        }
    }

    /**
     * @inheritDoc
     */
    getPeerMediaInfo(owner, mediaType) {
        if (this.chatRoom) {
            return this.chatRoom.getMediaPresenceInfo(owner, mediaType);
        }
        logger.error('Requested peer media info, before room was set');
    }

    /**
     * @inheritDoc
     */
    getSSRCOwner(ssrc) {
        return this.ssrcOwners.get(ssrc);
    }

    /**
     * Set an SSRC owner.
     * @param {number} ssrc an SSRC to be owned
     * @param {string} endpointId owner's ID (MUC nickname)
     * @throws TypeError if <tt>ssrc</tt> is not a number
     */
    setSSRCOwner(ssrc, endpointId) {
        if (typeof ssrc !== 'number') {
            throw new TypeError(`SSRC(${ssrc}) must be a number`);
        }
        this.ssrcOwners.set(ssrc, endpointId);
    }
}
