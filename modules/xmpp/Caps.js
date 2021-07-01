import { Strophe } from 'strophe.js'; // eslint-disable-line camelcase
import Listenable from '../util/Listenable';

export default class Caps extends Listenable {
    /**
     * Constructs new Caps instance.
     * @param {Strophe.Connection} connection the strophe connection object
     * @param {String} node the value of the node attribute of the "c" xml node
     * that will be sent to the other participants
     */
    constructor(connection = {}) {
        super();
        this.disco = connection.disco;
        if (!this.disco) {
            throw new Error(
                'Missing strophe-plugins '
                + '(disco plugin is required)!');
        }
        // We keep track of features added outside the library and we publish them
        // in the presence of the participant for simplicity, avoiding the disco info request-response.

        Strophe.addNamespace('CAPS', 'caps');
        this.disco.addFeature(Strophe.NS.CAPS);
    }

    /**
     * Adds new feature to the list of supported features for the local
     * participant
     * @param {String} feature the name of the feature.
     */
    addFeature(feature) {
        this.disco.addFeature(feature);
    }
}
