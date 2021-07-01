import JitsiConnection from './JitsiConnection';
import RTC from './modules/RTC/RTC';

export default window.JitsiMeetJS = {

    JitsiConnection,

    init(options = {}) {
        return RTC.init(options);
    },
}
