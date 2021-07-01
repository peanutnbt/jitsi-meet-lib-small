import { Strophe } from 'strophe.js';

import XMPPEvents from '../../service/xmpp/XMPPEvents';

import ChatRoom from './ChatRoom';
import { ConnectionPluginListenable } from './ConnectionPlugin';


/**
 * MUC connection plugin.
 */
export default class MucConnectionPlugin extends ConnectionPluginListenable {
    constructor(xmpp) {
        console.log("----------New MUC Plugin----------")
        super();
        this.xmpp = xmpp;
        this.rooms = {};
    }

    /**
     *
     * @param connection
     */
    init(connection) {
        super.init(connection);
        // add handlers (just once)
        this.connection.addHandler(this.onPresence.bind(this), null,
            'presence', null, null, null, null);
        this.connection.addHandler(this.onPresenceUnavailable.bind(this),
            null, 'presence', 'unavailable', null);
        this.connection.addHandler(this.onPresenceError.bind(this), null,
            'presence', 'error', null);
        this.connection.addHandler(this.onMessage.bind(this), null,
            'message', null, null);
    }

    /**
     *
     * @param jid
     * @param password
     * @param options
     */
    createRoom(jid, password, options) {
        const roomJid = Strophe.getBareJidFromJid(jid);
        console.log("----------MUC Create Room----------")

        if (this.rooms[roomJid]) {
            console.log("----------MUC Create Room----------: You are already in the room!")
            const errmsg = 'You are already in the room!';
            throw new Error(errmsg);
        }
        this.rooms[roomJid] = new ChatRoom(this.connection, jid,
            password, this.xmpp, options);

        return this.rooms[roomJid];
    }
    /**
     *
     * @param pres
     */
    onPresence(pres) {
        console.log("---------On presence-----------")
        const from = pres.getAttribute('from');

        // What is this for? A workaround for something?
        if (pres.getAttribute('type')) {
            return true;
        }

        const room = this.rooms[Strophe.getBareJidFromJid(from)];

        if (!room) {
            return true;
        }

        // Parse status.
        if ($(pres).find('>x[xmlns="http://jabber.org/protocol/muc#user"]'
            + '>status[code="201"]').length) {
            room.createNonAnonymousRoom();
        }

        room.onPresence(pres);

        return true;
    }

    /**
     *
     * @param pres
     */
    onPresenceUnavailable(pres) {
        const from = pres.getAttribute('from');
        const room = this.rooms[Strophe.getBareJidFromJid(from)];

        if (!room) {
            return true;
        }

        room.onPresenceUnavailable(pres, from);

        return true;
    }

    /**
     *
     * @param pres
     */
    onPresenceError(pres) {
        const from = pres.getAttribute('from');
        const room = this.rooms[Strophe.getBareJidFromJid(from)];

        if (!room) {
            return true;
        }

        room.onPresenceError(pres, from);

        return true;
    }

    /**
     *
     * @param msg
     */
    onMessage(msg) {
        // FIXME: this is a hack. but jingle on muc makes nickchanges hard
        const from = msg.getAttribute('from');
        const room = this.rooms[Strophe.getBareJidFromJid(from)];

        if (!room) {
            return true;
        }

        room.onMessage(msg, from);

        return true;
    }
}
