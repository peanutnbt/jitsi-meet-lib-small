import transform from 'sdp-transform';


const SIM_LAYER_1_RID = '1';
const SIM_LAYER_2_RID = '2';
const SIM_LAYER_3_RID = '3';

export const SIM_LAYER_RIDS = [ SIM_LAYER_1_RID, SIM_LAYER_2_RID, SIM_LAYER_3_RID ];

/**
 * Handles track related operations on TraceablePeerConnection when browser is
 * running in unified plan mode.
 */
export class TPCUtils {
    /**
     * Creates a new instance for a given TraceablePeerConnection
     *
     * @param peerconnection - the tpc instance for which we have utility functions.
     * @param videoBitrates - the bitrates to be configured on the video senders for
     * different resolutions both in unicast and simulcast mode.
     */
    constructor(peerconnection, videoBitrates) {
        this.pc = peerconnection;
        this.videoBitrates = videoBitrates.VP8 || videoBitrates;

        /**
         * The startup configuration for the stream encodings that are applicable to
         * the video stream when a new sender is created on the peerconnection. The initial
         * config takes into account the differences in browser's simulcast implementation.
         *
         * Encoding parameters:
         * active - determine the on/off state of a particular encoding.
         * maxBitrate - max. bitrate value to be applied to that particular encoding
         *  based on the encoding's resolution and config.js videoQuality settings if applicable.
         * rid - Rtp Stream ID that is configured for a particular simulcast stream.
         * scaleResolutionDownBy - the factor by which the encoding is scaled down from the
         *  original resolution of the captured video.
         */
        this.localStreamEncodingsConfig = [
            {
                active: true,
                maxBitrate: this.videoBitrates.high,
                rid: SIM_LAYER_1_RID,
                scaleResolutionDownBy: 1.0
            },
            {
                active: true,
                maxBitrate: this.videoBitrates.standard,
                rid: SIM_LAYER_2_RID,
                scaleResolutionDownBy: 2.0
            },
            {
                active: true,
                maxBitrate: this.videoBitrates.low,
                rid: SIM_LAYER_3_RID,
                scaleResolutionDownBy: 4.0
            }
        ];
    }

    /**
     * Obtains stream encodings that need to be configured on the given track based
     * on the track media type and the simulcast setting.
     * @param {JitsiLocalTrack} localTrack
     */
    _getStreamEncodings(localTrack) {
        if (this.pc.isSimulcastOn() && localTrack.isVideoTrack()) {
            return this.localStreamEncodingsConfig;
        }

        return localTrack.isVideoTrack()
            ? [ {
                active: true,
                maxBitrate: this.videoBitrates.high
            } ]
            : [ { active: true } ];
    }

    /**
     * Ensures that the ssrcs associated with a FID ssrc-group appear in the correct order, i.e.,
     * the primary ssrc first and the secondary rtx ssrc later. This is important for unified
     * plan since we have only one FID group per media description.
     * @param {Object} description the webRTC session description instance for the remote
     * description.
     * @private
     */
    ensureCorrectOrderOfSsrcs(description) {
        const parsedSdp = transform.parse(description.sdp);

        parsedSdp.media.forEach(mLine => {
            if (mLine.type === 'audio') {
                return;
            }
            if (!mLine.ssrcGroups || !mLine.ssrcGroups.length) {
                return;
            }
            let reorderedSsrcs = [];

            mLine.ssrcGroups[0].ssrcs.split(' ').forEach(ssrc => {
                const sources = mLine.ssrcs.filter(source => source.id.toString() === ssrc);

                reorderedSsrcs = reorderedSsrcs.concat(sources);
            });
            mLine.ssrcs = reorderedSsrcs;
        });

        return new RTCSessionDescription({
            type: description.type,
            sdp: transform.write(parsedSdp)
        });
    }

    /**
    * Adds {@link JitsiLocalTrack} to the WebRTC peerconnection for the first time.
    * @param {JitsiLocalTrack} track - track to be added to the peerconnection.
    * @param {boolean} isInitiator - boolean that indicates if the endpoint is offerer in a p2p connection.
    * @returns {void}
    */
    addTrack(localTrack, isInitiator) {
        const track = localTrack.getTrack();

        if (isInitiator) {
            // Use pc.addTransceiver() for the initiator case when local tracks are getting added
            // to the peerconnection before a session-initiate is sent over to the peer.
            const transceiverInit = {
                direction: 'sendrecv',
                streams: [ localTrack.getOriginalStream() ],
                sendEncodings: []
            };

            // if (!browser.isFirefox()) {
            //     transceiverInit.sendEncodings = this._getStreamEncodings(localTrack);
            // }
            this.pc.peerconnection.addTransceiver(track, transceiverInit);
        } else {
            // Use pc.addTrack() for responder case so that we can re-use the m-lines that were created
            // when setRemoteDescription was called. pc.addTrack() automatically  attaches to any existing
            // unused "recv-only" transceiver.
            this.pc.peerconnection.addTrack(track);
        }
    }

}
