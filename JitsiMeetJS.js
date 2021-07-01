import * as JitsiConferenceEvents from './JitsiConferenceEvents';
import JitsiConnection from './JitsiConnection';
import * as JitsiConnectionEvents from './JitsiConnectionEvents';
import RTC from './modules/RTC/RTC';

export default window.JitsiMeetJS = {

    JitsiConnection,

    events: {
        conference: JitsiConferenceEvents,
        connection: JitsiConnectionEvents,
    },
    init(options = {}) {
        return RTC.init(options);
    },
}
