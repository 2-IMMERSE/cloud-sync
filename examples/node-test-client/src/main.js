
// ---------------------------------------------------------
//  Declarations
// ---------------------------------------------------------

var commandLineArgs, logger, url, config, fs, ClientController, controller;



commandLineArgs = require("command-line-args");
const commandLineUsage = require("command-line-usage");
Logger = require("./logger");
url = require("url");
fs = require('fs');
ClientController = require("./ClientController");
const SynchroniserLib = require("./Synchroniser");


var config = {
    syncURL : undefined,
    sessionId : undefined,
    deviceId: undefined,
    syncMode : undefined

}


// ---------------------------------------------------------
//  Start
// ---------------------------------------------------------
// command line usage guide
const sections = [
    {
      header: 'Cloud-Sync Node JS Client',
      content: 'Runs a test client'
    },
    {
      header: 'Options',
      optionList: [
        {
            name: 'help',
            description: 'Display usage guide.',
            alias: 'h',
            type: Boolean
          },
          {
            name: 'syncurl',
            description: 'cloud-sync service WS URL',
            alias: 'u',
            type: String,
            typeLabel: '{underline URL}'
          },
          {
            name: 'sessionid',
            description: 'A session code',
            alias: 's',
            type: String,
            typeLabel: '{underline ID}'
          },
          {
            name: 'deviceid',
            description: 'An id for this client. Optional.',
            alias: 'd',
            type: String,
            typeLabel: '{underline ID}'
          },
          {
            name: 'mode',
            description: 'Sync mode. 1 - MASTER/SLAVE, 2 -DYNAMIC (default)',
            alias: 'm',
            type: Number,
            typeLabel: '{underline 1|2}'
          },
          {
            name: 'role',
            description: 'Specify role: master (m) or slave (s), if mode == 1',
            alias: 'r',
            type: String,
            typeLabel: '{underline m|s}'
          },
          {
            name: 'verbose',
            description: 'Log level',
            alias: 'v',
            type: Boolean,
          }
      ]
    }
  ]
const usage = commandLineUsage(sections)

const optionDefinitions = [
    { name: "syncurl", alias: "u", type: String },
    { name: "sessionid", alias: "s", type: String },
    { name: "deviceid", alias: "d", type: String },
    { name: "role", alias: "r", type: String },
    { name: "syncmode", alias: "m", type: Number }, 
    { name: "help", alias: "h", type: Boolean },
	{ name: 'verbose', alias: 'v', type: Boolean, defaultValue: false },
];

try {
    var options = commandLineArgs(optionDefinitions);

    if (options.help == true)
    {
        console.log(usage);
    }else
    {
        options.loglevel = options.verbose ? "development" : "info";
        logger = Logger.getNewInstance(options.loglevel, "cloudsynctestclient");
        
        if (((typeof  options.syncurl === "undefined") || (  options.syncurl === null)) 
            || ((typeof  options.sessionid === "undefined") || (  options.sessionid === null)) 
            || ((typeof  options.syncmode === "undefined") || (  options.syncmode === null))
        )
        {
            throw "Missing one of these parameters: --syncurl (-u), --sessionid (-s), --syncmode (-m)";
        } 
        
        if (options.syncmode ===  SynchroniserLib.SyncTLElection.EARLIEST_FIRST)
        {
            if ((typeof  options.role === "undefined") || ( options.role === null))
            {
                throw "Missing role parameter: --role -r";
            }
        }
        
        config.syncURL = options.syncurl || "cloudsync.virt.ch.bbc.co.uk";
        config.sessionId = options.sessionid;
        config.loglevel = options.loglevel;
        process.env.loglevel = options.loglevel;
        config.deviceId = options.deviceid || "csclient-" + uuidv4();

        config.syncMode = options.syncmode;
        
        // if we are in EARLIEST_FIRST sync-mode, use 'role' to select test plan
        if (options.syncmode === SynchroniserLib.SyncTLElection.EARLIEST_FIRST)
        {
            config.role = options.role;
            if (options.role == "m")
            {
                config.planfile = "config/masterplan.json";
            }else if (options.role == "s")
            {
                config.planfile = "config/auxplan.json";
            }else
            {
                config.planfile = "config/masterplan.json";
            }

        }else // we are in DYNAMIC sync-mode and we use master test plan
        {
            config.role = "m";
            config.planfile = "config/masterplan.json";
        }


        config.plan = JSON.parse(fs.readFileSync(config.planfile, 'UTF-8'));

        if ((typeof  config.plan === "undefined") || ( config.plan === null))
        {
            throw "Error loading test plan file. No plan to execute.";
        }
        
        logger.info("running node app with these params: ");
        console.log(config)

        controller = new ClientController(config);
        controller.start();
        // CRTL-C handler
		process.on("SIGINT", function() {
			controller.stop();
			process.exit();
		});   
       
    }
    

} catch (e) {
	logger.error(e);
}

// ---------------------------------------------------------------


// function handleDeviceRegistrationSuccess () {
//     logger.info("Event:", "DeviceRegistrationSuccess");
// }

// function handleDeviceRegistrationError (e) {
//     logger.error("DeviceRegistrationError" + e);
// }

// function handleWallClockAvailable () {
//     logger.info("Event:", "WallClockAvailable");
//     logger.info("Schedule video clocks creation.");
//     scheduleStartClocks.call(this);
//     scheduleAllOtherJobs();
// }

// function handleWallClockUnAvailable () {
//     logger.error("Event:", "WallClockUnAvailable");
// }

// function handleSyncServiceUnavailable (e) {
//     logger.error("SyncServiceUnavailable", e);
// }


// function handleSyncTimelinesAvailable (e) {
//     logger.info("SyncTimelinesAvailable", e);
// }

// // ---------------------------------------------------------------

// function getAvailableDevices () {
//     logger.info("Call:  CloudSynchroniser.getAvailableDevices()");
//     synchroniser.getAvailableDevices().
//         catch (function (e) { logger.error(e) }).
//     then (function (devices) { 
//         sessionInfo.devices = devices;
//     });
// }

// function connectToSyncService()
// {
//     synchroniser = new SynchroniserLib.CloudSynchroniser(
//         { hostname: config.syncURL},
//         config.sessionId,
//         "DEFAULT",
//         config.deviceId,
//         {
//             syncTimelineElection: config.syncMode
//         }      
//     );
    
//     synchroniser.on("DeviceRegistrationError", handleDeviceRegistrationError.bind(this));
//     synchroniser.on("DeviceRegistrationSuccess", handleDeviceRegistrationSuccess.bind(this));
//     synchroniser.on("WallClockUnAvailable", handleWallClockUnAvailable.bind(this));
//     synchroniser.on("WallClockAvailable", handleWallClockAvailable.bind(this));
//     synchroniser.on("SyncServiceUnavailable", handleSyncServiceUnavailable);
//     synchroniser.on("SyncTimelinesAvailable", handleSyncTimelinesAvailable);
// }
   
// function scheduleStartClocks()
// {
//    var self = this;
//     for (const action of sessionInfo.plan.actions) {
//        if (action.name === "start_clock")
//        {
//             setTimeout(createVideoTimelineClock.bind(self), action.time_secs * 1000, action.params["contentid"],  action.params["timelinetype"], logger);
//        }
//    }
// }


// function createVideoTimelineClock (contentId, timelineType, logger) {
//     var videoElement = undefined;
//     var videoCtrl = undefined;
//     sessionInfo.contentId = contentId;
//     sessionInfo.timelineType = timelineType;
     
//     if (videoClockObj === null) {
//         videoClockObj = new VideoClock(synchroniser.wallclock, videoElement, videoCtrl);
//         videoClockObj.on("change", function () {
//             console.log("Video clock " + videoClockObj.id +" changed");
//         });
//    }
// }





// function destroy () {
//     console.log("Call: CloudSynchroniser.destroy()");
//     synchroniser.destroy();
// }

// syncUrl = { hostname: config.hostname, port: config.port };






// function init () {
//     initSessionSettings();

//     $("source")[0].src = getUrlParameter("video") || "http://hbbtv-live.irt.de/2immerse/video.mp4";

//     DisplayFactory.createDeviceInfoDisplay("display", "Device Info", deviceInfo);
//     DisplayFactory.createSessionInfoDisplay("display", "Session Info", sessionInfo);
//     DisplayFactory.refreshAll();

//     $("input").on("change", function () { 
//         sessionInfo[this.name] = this.value || "default"; 
//     });
//     $(".cloudsynchroniser-api").on("click", doWhatsWrittenOnTheButton);
// }

// function initSessionSettings () {
//     if (sessionInfo.sessionId !== "default") $("#sessionId").value = sessionInfo.sessionId;
//     if (sessionInfo.contextId !== "default") $("#contextId").value = sessionInfo.contextId;
//     if (sessionInfo.electionAlgorithm !== "EarliestFirst") {
//         $("#EarliestFirst").removeAttribute("checked");
//         $("#" + sessionInfo.electionAlgorithm).setAttribute("checked", true);
//     }
// }

// function doWhatsWrittenOnTheButton () {
//     eval(this.innerHTML);
// }

// function share (method) {

//     var selectList, os;

//     selectList =  [];
//     selectList.push({ name: "QR code", action: showQrCode });
//     selectList.push({ name: "e-mail", action: sendEmail });
//     selectList.push({ name: "In new Window", action: openInNewWindow });
//     selectList.push({ name: "In new Tab", action: openInNewTab });

//     // Add share options for mobile platforms
//     if (["android", "ios"].indexOf(getOs().toLowerCase()) > -1) {
//         selectList.push({ name: "WhatsApp", action: sendWhatsApp });
//     }

//     selectList.push({ name: "Cancel", action: function () {} });
    
//     $("body")[0].appendChild(new SelectList("Share via", selectList));
// }

// function getOs () {
//     var ua = navigator.userAgent.toLowerCase();
//     if (ua.indexOf("ios") > -1) return "ios";
//     if (ua.indexOf("android") > -1) return "android";
//     return "any";
// }

// function join (event) {
//     var timelineElectionAlgorithm;

//     console.log("Call:  CloudSyncKit.getCloudSynchroniser()");
//     console.log("syncUrl:", JSON.stringify(syncUrl));

//     switch (sessionInfo.electionAlgorithm) {
//         case "EarliestFirst":
//             timelineElectionAlgorithm = CloudSyncKit.SyncTLElection.EARLIEST_FIRST;
//             break;
//         case "LowestDispersion":
//             timelineElectionAlgorithm = CloudSyncKit.SyncTLElection.LOWEST_DISPERSION;
//             break;
//         case "Dynamic":
//             timelineElectionAlgorithm = CloudSyncKit.SyncTLElection.DYNAMIC;
//             break;
//         default:
//             timelineElectionAlgorithm = CloudSyncKit.SyncTLElection.DYNAMIC;
//             break;
//     }
//     console.log("timelineElectionAlgorithm = " , timelineElectionAlgorithm);

//     synchroniser = CloudSyncKit.getCloudSynchroniser(
//         syncUrl,
//         sessionInfo.sessionId,
//         sessionInfo.contextId,
//         deviceInfo.deviceId,
//         {
//             syncTimelineElection: timelineElectionAlgorithm
//         }
//     );

//     synchroniser.on("DeviceRegistrationError", handleDeviceRegistrationError);
//     synchroniser.on("DeviceRegistrationSuccess", handleDeviceRegistrationSuccess);
//     synchroniser.on("WallClockUnAvailable", handleWallClockUnAvailable);
//     synchroniser.on("WallClockAvailable", handleWallClockAvailable);
//     synchroniser.on("SyncServiceUnavailable", handleSyncServiceUnavailable);
//     synchroniser.on("SyncTimelinesAvailable", handleSyncTimelinesAvailable);

//     $("#btn-join").className = "pure-button button-error";
//     $("#btn-join").innerHTML = "destroy()";
// }

// function handleDeviceRegistrationSuccess () {
//     console.info("Event:", "DeviceRegistrationSuccess");
//     toastr.info("DeviceRegistrationSuccess");
// }

// function handleDeviceRegistrationError (e) {
//     console.error("DeviceRegistrationError", e);
//     toastr.error("DeviceRegistrationError");
// }

// function handleWallClockAvailable () {
//     console.info("Event:", "WallClockAvailable");
//     displayWallclock();
//     toastr.info("WallClockAvailable");
// }

// function handleWallClockUnAvailable () {
//     console.error("Event:", "WallClockUnAvailable");
// }

// function handleSyncServiceUnavailable (e) {
//     console.error("SyncServiceUnavailable", e);
//     toastr.error("SyncServiceUnavailable");
// }

// function handleSyncTimelinesAvailable (e) {
//     console.info("SyncTimelinesAvailable", e);
//     toastr.success("SyncTimelinesAvailable (#STL: " + e.length + ")");


// }




// function getAvailableDevices () {
//     console.log("Call:  CloudSynchroniser.getAvailableDevices()");
//     synchroniser.getAvailableDevices().
//         catch (function (e) { console.error(e) }).
//     then (function (devices) { 
//         sessionInfo.devices = devices;
//     });
// }

// function setContentId () {
//     synchroniser.contentId = $("video")[0].src;
//     deviceInfo.contentId = synchroniser.contentId;
// }

// function createVideoTimelineClock () {
//     var video = $("video")[0];
//     var videoCtrl = videojs("video", { muted: true, controls: true });
    
//     if (videoClockObj === null) {
//         videoClockObj = new VideoClock(synchroniser.wallclock, video, videoCtrl);
//         videoClockObj.on("change", function () {
//             console.log("%cVideo clock changed", "background-color:yellow;", JSON.stringify(videoClockObj));
//         });
        
//         DisplayFactory.createClockDisplay("display", "Video Clock", videoClockObj, "utc");
//         // DisplayFactory.createPlayerInfoDisplay("videoContainer", "Player Info", video, videoClockObj, "utc");

//         // Make video player follow the video clock
//         VideoSynchroniser(videoClockObj, video);
//     }
// }

// function synchroniseVideoTimelineClock () {
//     createVideoTimelineClock();
//     synchroniser.synchronise(videoClockObj, videoTimelineType, $("video")[0].src);
// }

// function addTimelineClock () {
//     createVideoTimelineClock();
//     synchroniser.addTimelineClock(videoClockObj, videoTimelineType, $("video")[0].src, {useForSessionSync: true, writable:true}).then(console.log);
// }

// function getAvailableTimelines () {
//     console.log("Call: CloudSynchroniser.getAvailableTimelines()");

//     synchroniser.getAvailableTimelines().
//        catch (function (e) { console.error(e) }).
//        then (function (timelineInfo) { 
//            sessionInfo.timelineInfo = timelineInfo;
//        });
// }

// function getAvailableSyncTimelines () {
//     console.log("Call: CloudSynchroniser.getAvailableSyncTimelines()");

//     synchroniser.getAvailableSyncTimelines().
//        catch (function (e) { console.error(e) }).
//        then (function (timelineInfo) { 
//            sessionInfo.syncTimelineInfo = timelineInfo;
//        });
// }

// function subscribeTimeline () {
//     var timelines = sessionInfo.timelineInfo.concat(sessionInfo.syncTimelineInfo);
//     createTimelineList(function () {
//         console.log("Call: CloudSynchroniser.subscribeTimeline()");
//         synchroniser.subscribeTimeline(this.name);
//     }, "Subscribe to timeline", timelines);
// }

// function showTimelineClock () {
//     var timelines = sessionInfo.timelineInfo.concat(sessionInfo.syncTimelineInfo);
//     createTimelineList(function () {
//         var timelineClock = synchroniser.getTimelineClockById(this.name);
//         DisplayFactory.createClockDisplay("display", "Timeline Clock", timelineClock, "utc");
//     }, "Subscribe to timeline", timelines);
// }


// function syncClockToThisTimeline () {
//     var timelines = sessionInfo.timelineInfo.concat(sessionInfo.syncTimelineInfo);
//     createTimelineList(function () {
//         console.log("Call: CloudSynchroniser.syncClockToThisTimeline()");
//         synchroniser.syncClockToThisTimeline(videoClockObj, this.name);
//     }, "Select timeline", timelines);
// }

// function createTimelineList (onSelected, listHeading, timelines) {
//     var selectList =  [];
    
//     timelines.forEach(function (info) {
//         selectList.push({
//             name: info.timelineId,
//             timelineInfo: info,
//             action: onSelected
//         });
//     });

//     selectList.push({ name: "Cancel", action: function () {} });
    
//     $("body")[0].appendChild(new SelectList(listHeading, selectList));  
// }



// function appendUrlParams (url, params) {
//     params.forEach(function (param) {
//         // Check if this parameter already exists
//         if (getUrlParameter(param.name, url) === null) {
//             url += url.indexOf("?") > -1 ? "&" : "?";
//             url += param.name + "=" + param.value;
//         }
//     });
//     return url;
// }

// function getUrlParameter (name, URL) {
//     var url, regex, results;
//     url = URL || location.href;
//     name = name.replace(/[\[]/,"\\\[").replace(/[\]]/,"\\\]");
//     regex = new RegExp("[\\?&]"+name+"=([^&#]*)");
//     results = regex.exec( url );
//     return results == null ? null : results[1];
// }


// source: https://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript
function uuidv4 () {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}