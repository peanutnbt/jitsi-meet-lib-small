import { Strophe } from 'strophe.js';

export default function() {
    Strophe.getStatusString = function(status) {
        switch (status) {
        case Strophe.Status.BINDREQUIRED:
            return 'BINDREQUIRED';
        case Strophe.Status.ERROR:
            return 'ERROR';
        case Strophe.Status.CONNECTING:
            return 'CONNECTING';
        case Strophe.Status.CONNFAIL:
            return 'CONNFAIL';
        case Strophe.Status.AUTHENTICATING:
            return 'AUTHENTICATING';
        case Strophe.Status.AUTHFAIL:
            return 'AUTHFAIL';
        case Strophe.Status.CONNECTED:
            return 'CONNECTED';
        case Strophe.Status.DISCONNECTED:
            return 'DISCONNECTED';
        case Strophe.Status.DISCONNECTING:
            return 'DISCONNECTING';
        case Strophe.Status.ATTACHED:
            return 'ATTACHED';
        default:
            return 'unknown';
        }
    };
}
