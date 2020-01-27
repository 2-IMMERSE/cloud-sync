/****************************************************************************
/* FILE:                MTenantSessionController.js                			*/
/* DESCRIPTION:         class for a multi-tenant Session Controller         */
/* VERSION:             (see git)                                       	*/
/* DATE:                (see git)                                       	*/
/* AUTHOR:              Rajiv Ramdhany <rajiv.ramdhany@bbc.co.uk>    		*/

/* Copyright 2015 British Broadcasting Corporation							*/

/* Unless required by applicable law or agreed to in writing, software		*/
/* distributed under the License is distributed on an "AS IS" BASIS,		*/
/* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.	*/
/* See the License for the specific language governing permissions and		*/
/* limitations under the License.											*/
/****************************************************************************/


// ---------------------------------------------------------
//  Declarations
// ---------------------------------------------------------
var MessageIdGenerator = require("../../common/message/MessageIdGenerator");
var MessageFactory = require("../../common/message/Message");
var Messenger = require("../../common/messenger/Messenger");
var MessagingAdapter = require("../../common/messenger/messagingadapter/MqttMessagingAdapter");
var RedisConnection = require("../../common/datastore/redisconnection");  
var RedisSMQConfig = require("../../common/events/RedisSMQConfig");
const TimelineInfo = require("../../common/message/TimelineInfo");
const Timeline = require("../../common/state/Timeline");
const Device = require("../../common/state/Device");
const Session = require("../../common/state/Session");
const Logger = require("../../common/logger/logger");
const uuidv4 = require("uuid/v4");
const Producer = require("redis-smq").Producer;
const Monitor = require("redis-smq").monitor;

var SyncEvents = require("../../common/events/syncevents_pb");


var PRIVATE = new WeakMap();
var logger;

// ---------------------------------------------------------
//  Constants
// ---------------------------------------------------------
const kSyncControllerQueueKey = "cloudsync_synccontroller_waitQueue";
const kOnboardingChannel = "Sessions/REQ";
const kSessionREQTopic = "Sessions/REQ";
const kSessionRESPTopic = "Sessions/RESP";
const kSessionLastWillTopic = "Sessions/lastwill";
const kMockContextId = "MockContextId";

// ---------------------------------------------------------
//  MTenantSessionController class
// ---------------------------------------------------------
/**
 * @class MTenantSessionController
 */
class MTenantSessionController{

	/**
	 * 
	 * @param {object} services service endpoints 
	 * @param {object} config 
	 */
	constructor(services)
	{
		PRIVATE.set(this,{});
		var priv = PRIVATE.get(this);

		// service endpoints
		priv.wallclockservice_udp = services.wallclockservice_udp;
		priv.wallclockservice_ws = services.wallclockservice_ws;
		priv.mosquitto = services.mqttbroker;
		priv.redis = services.redis;


		// clients
		priv.messenger = undefined;
		priv.redisClient = undefined;

		// some service private state		
		priv.onBoardingChannel = kOnboardingChannel;
		priv.channels = [kOnboardingChannel]; // channels this session controller is subscribed to

		logger = Logger.getNewInstance(process.env.loglevel);
	}

	// ---------------------------------------------------------

	/**
	 * Starts the controller, discovers other services and listens to communications channels
	 * to receive requests.
	 */
	start()
	{
		var self = this;

		return setupSessionController.call(self);
	}

	// ---------------------------------------------------------

	/**
	 * Stop the controller. Unsubscribes the component from all channels it was listening to.
	 * 
	 */
	stop(){
		var priv = PRIVATE.get(this);
		priv.messenger.stopListenAll();
		priv.messenger.disconnect();
		if (typeof priv.syncCrtlQProducer !== "undefined")
		{
			priv.syncCrtlQProducer.shutdown();
		}
		
		logger.info("stopped listening to channels");
	}

	// ---------------------------------------------------------

}

// ---------------------------------------------------------
//  MTenantSessionController class private methods
// ---------------------------------------------------------

/**
 * Set up data peristence service and communication channels
 */
function setupSessionController() {

	var self = this;
	var priv = PRIVATE.get(this);

	
	logger.debug("connecting to Redis endpoint " + JSON.stringify(priv.redis));
	priv.redisClient = RedisConnection("DEFAULT", priv.redis);

	priv.redisClient.on("error", function (err) {
		logger.error("Redis connection Error : " + err);
	});
	logger.info("connected to redis.");

	// setup redis-smq producer
	priv.redissmqConfig = new RedisSMQConfig(priv.redis.host, priv.redis.port, "127.0.0.1", 4000);
	logger.debug("Reliable queue config: ", JSON.stringify(priv.redissmqConfig.getConfig()));
	priv.syncCrtlQProducer = new Producer(kSyncControllerQueueKey, priv.redissmqConfig.getConfig()); 

	priv.syncCrtlQMonitor = new Monitor(priv.redissmqConfig.getConfig());

	priv.syncCrtlQMonitor.listen(()=>{
		logger.info("SyncController Queue monitor running on port 4000");
	});


	priv.msgAdapter = new MessagingAdapter(priv.mosquitto.host, priv.mosquitto.port, "sessioncontroller_" + uuidv4());
	priv.msgAdapter.on("connectionestablished", handleAdapterConnected.bind(null, priv.mosquitto));
	priv.msgAdapter.on("connectionfailure", handleAdapterConnectionFailure);
		
		
	priv.messenger = new Messenger(priv.msgAdapter);
	priv.messenger.on("request", handleIncomingRequest.bind(self));
	priv.messenger.on("message", handleIncomingMessage.bind(self));
		
	
	priv.messenger.listen(priv.onBoardingChannel);
	priv.channels.push(priv.onBoardingChannel);
		
	logger.info("Listening to requests on channel: ", priv.onBoardingChannel);

	priv.sessionREQTopic = kSessionREQTopic;
	priv.sessionRESPTopic = kSessionRESPTopic;
	priv.sessionLastWillTopic = kSessionLastWillTopic;

	priv.messenger.listen(kSessionREQTopic);
	priv.channels.push(kSessionREQTopic);
	priv.messenger.listen(kSessionRESPTopic);
	priv.channels.push(kSessionRESPTopic);
	priv.messenger.listen(kSessionLastWillTopic);
	priv.channels.push(kSessionLastWillTopic);
		
	logger.info("SessionController listening to session REQ channel:", kSessionREQTopic);
	logger.info("SessionController listening to session RESP channel:", kSessionRESPTopic);
	logger.info("SessionController listening to session lastwill channel:", kSessionLastWillTopic);

	return Promise.resolve(true);	
}



// ---------------------------------------------------------


function handleAdapterConnected (serviceEndpoint) {
	logger.info("Connected to mqtt broker:", serviceEndpoint.host + ":" + serviceEndpoint.port);
}

// ---------------------------------------------------------

function handleAdapterConnectionFailure (error) {
	logger.error(error);

}



// ---------------------------------------------------------
// Requests and message dispatch to handlers
// ---------------------------------------------------------

/**
 * Handler for client requests. Dispatches messages to individual handlers
 * based on the request type.
 * @param {Object} request 
 */
function handleIncomingRequest (request) {

	var self = this;

	logger.debug(" ============================ REQ RECEIVED ====================================");
	logger.debug("Received request: ", messageTypeAsString(request), " : ", JSON.stringify(request));
	// logger.info("Received", request.messageType, "from device:", request.senderId);
	
	switch (request.messageType) {
	case MessageFactory.MessageType.JOIN_REQ:
		handleJoinREQ.call(self, request);
		
		break;
	case MessageFactory.MessageType.LEAVE_REQ:
		handleLeaveREQ.call(self, request);
		
		break;
	case MessageFactory.MessageType.DEVICE_REQ:
		handleDeviceREQ.call(self, request);
		
		break;
	case MessageFactory.MessageType.TIMELINE_REQ:
		handleTimelineREQ.call(self, request);
		break;
	
	case MessageFactory.MessageType.TIMELINE_REG_REQ:
		handleTimelineRegistrationREQ.call(self, request);
		break;
	case MessageFactory.MessageType.TIMELINE_SUB_REQ:
		handleTimelineSubscriptionREQ.call(self, request);
		break;
	case MessageFactory.MessageType.UNEXPECTED_DEVICE_EXIT:
		handleUnexpectedDeviceExit.call(self, request);
		break;
	default:
		logger.warn("No handler for", request.messageType,"request");
	}

	
}

// ---------------------------------------------------------

/**
 * Handle messages from clients
 * @param {Message} message 
 */	
function handleIncomingMessage (message) {

	var self = this;

	logger.debug(" ============================ MSG RECEIVED ====================================");
	logger.debug("Received message ", messageTypeAsString(message), " : ", JSON.stringify(message));
		
	switch (message.messageType) {
	case MessageFactory.MessageType.CONTENT_ID_CHANGE:
		handleContentIdChange.call(this, message);
		break;
	case MessageFactory.MessageType.UNEXPECTED_DEVICE_EXIT:
		handleUnexpectedDeviceExit.call(self, message);
		break;
	default:
		logger.warn("No handler for message type: ", message.messageType);
	}
}



// ---------------------------------------------------------
// Device Join REQ Handler
// ---------------------------------------------------------

/**
 * Handler for JoinREQ request message
 * @param {Message} request 
 */
function handleJoinREQ(request) {

	var self = this, currentSession;
	var priv = PRIVATE.get(this);
	var sessionInfo = {
		wallclockUrl : (typeof process.env.WALLCLOCK_SERVICE_WS_URL !== "undefined") ?  process.env.WALLCLOCK_SERVICE_WS_URL : "ws://" + priv.wallclockservice_ws.host + ":" + priv.wallclockservice_ws.port,
		sessionControllerUrl : "ws://sessionsynccontroller.example.com"
	};

	createSessionIfNotExist.call(self, request).then((session)=>{
		logger.debug("JoinREQ handler: session found - ", session.id);
		currentSession = session;
		return registerDevice.call(self, request, session);
	}).then((result) =>{ 
		
		logger.info("JoinREQ handler: device %s added - %s", request.senderId, result);

		var message = new MessageFactory.DeviceStatus(request.sessionId, request.senderId, request.senderId, "online");
		var deviceStatusTopic = "Sessions/" + request.sessionId + "/state";
		
		priv.messenger.send(message, deviceStatusTopic);
	
		logger.debug("JoinREQ handler: Sent DeviceStatus{'online'} msg to '", deviceStatusTopic, "'");
	
		sendJoinResponse.call(self, request, 0, sessionInfo /* OKAY */);
		return true;
	}).then(()=>{
		return sendSyncTimelinesAvailable.call(self, currentSession, request.responseChannel);
	}).then(()=>{
		logger.debug("JoinREQ handler: Sent SYNC_TIMELINES_AVAILABLE message to channel: ", request.responseChannel);
	}).catch(() =>{ 
		sendJoinResponse.call(self, request, 1, sessionInfo /* Processing Error */);
	});	


}
	
// ---------------------------------------------------------


function createSessionIfNotExist(request)
{
	var priv = PRIVATE.get(this);
	
	return new Promise((resolve, reject) =>{
		Session.getFromDataStore(request.sessionId, priv.redisClient).catch((error)=>{
			logger.error("session lookup error: " + error);
			reject(error);
		}).then((session)=>{
			if (session) {
				resolve(session);
			}
			else{
				var s = new Session(request.sessionId,request.sessionId, request.syncTLStrategy, priv.redisClient, true);
				logger.debug("Session %s created.", s.id);
				resolve(s);			
			}
		});
	});	
}

// ---------------------------------------------------------

/**
 * Registers a device for the specified session and context
 * @param {Message} request JoinREQ object 
 * @param {Session} session Session object
 * @returns {Promise<Device>} a Promise object that resolves to a Device object if successful or to null if the promise is rejected. 
 */
function registerDevice (request, session) {

	var priv = PRIVATE.get(this);

	if ((typeof session === "undefined") || (session ===null) || !(session instanceof Session))
		return Promise.reject("registerDevice - Invalid session parameter");
	else
	{
		var newDevice = new Device(request.senderId, session.id, kMockContextId, request.responseChannel, 
			request.requestChannel, priv.redisClient, true);
		return session.addDevice(newDevice, true);
	}
}

// ---------------------------------------------------------

/**
 * Send response to JoinREQ message
 * @param {Message} request 
 * @param {number} responseCode 
 * @param {Object} sessionInfo 
 */
function sendJoinResponse (request, responseCode, sessionInfo) {
	var self = this;
	var response = new MessageFactory.JoinRESP(request.sessionId, responseCode, sessionInfo.wallclockUrl, request.id, request.version);

	sendResponse.call(self, response, request.responseChannel);
}

// ---------------------------------------------------------

function sendSyncTimelinesAvailable(session, channel)
{
	var self = this;
	var priv, message;
	priv = PRIVATE.get(self);

	if ((typeof session === "undefined") || (session === null) || !(session instanceof Session)){
		logger.error("sendSyncTimelinesAvailable - invalid session parameter");
		return;
	}

	return new Promise((resolve, reject) =>{

		session.getSyncTimelines().then((timelines)=>{

			var timelineInfoList = [];	
	
			for (let t of timelines) {
				if (t instanceof Timeline){
					var ti = t.getInfo();
					timelineInfoList.push(ti);			
				}				
			}
			
			message = new MessageFactory.SyncTimelinesAvailable(session.id, timelineInfoList);
			priv.messenger.send(message, channel);
			resolve();

		}).catch((err)=>{reject(err);});
	});
} 

// ---------------------------------------------------------
// Device Leave REQ Handler
// ---------------------------------------------------------
/**
 * Handler for LeaveREQ message
 * @param {Message} request 
 */
function handleLeaveREQ(request) {
	var self = this;
	var priv = PRIVATE.get(this);
	var deviceStatusTopic = "Sessions/" + request.sessionId + "/state";
	var mysession;
	
	unRegisterDevice.call(self, request)
		.catch(() => { sendLeaveResponse.call(self, request, 1 /* Processing Error */); })
		.then(()=>{

			var message = new MessageFactory.DeviceStatus(request.sessionId, request.senderId, request.senderId, "offline");
					
			priv.messenger.send(message, deviceStatusTopic);
			logger.debug("handleLeaveREQ() - SessionController sent:" , JSON.stringify(message) ,  " to '", deviceStatusTopic, "'");


			sendLeaveResponse.call(self, request, 0 /* OKAY */);
			return Session.getFromDataStore(request.sessionId, priv.redisClient);				
			
		}).catch((error)=>{
			logger.debug("unknown session search result: " + error);
		}).then((session)=>{
			logger.silly("Session lookup:", session);
			if (session)
			{
				mysession = session;
				return session.getDevices();
			}else
			{
				return Promise.resolve([]);
			}
		}).then((devices)=>{
			logger.silly("devices num: ", devices.length);
			if ((devices.length === 0) && (mysession))
			{
				logger.debug("Cleaning session: ", mysession.id);
				return mysession.cleanUp(); 
			}else
				return Promise.resolve(false);
		}).catch((error)=>{
			logger.error("session clean-up error: " + error);
		}).then((result)=>{
			if (result)
			{
				logger.info("Session '" , mysession.id, "' deleted.");				
			}
		});
}

// ---------------------------------------------------------

function unRegisterDevice(request) {

	var self = this;
	var priv = PRIVATE.get(this);
	var timelinesToSignal=null;

	return new Promise((resolve, reject)=>{

		Device.getFromDataStore(request.senderId, request.sessionId, priv.redisClient).then((device)=>{

			if (device) return device.getTimelines();
			else resolve(false);

		}).then((timelines)=>{

			// console.log("TEST 1 unRegisterDevice");
			timelinesToSignal = timelines;
			return Session.getFromDataStore(request.sessionId, priv.redisClient);
		}).then((session)=>{
			// console.log(session);
			if (session){
				// console.log("unRegisterDevice():", session.id);
				return session.removeDevice(request.senderId);
			}else
				return Promise.resolve(false);
		}).then((result)=>{
			
			if ((timelinesToSignal) && (timelinesToSignal.length > 0))
			{
				for (const t of timelinesToSignal) {

					t.useForSessionSync = t.useForSessionSync == "true" ? true : false;
					if (t.useForSessionSync == true)
						sendDelSyncTLEventToQueue.call(self, request, t);
				}				
			}
			
			resolve(result);
		}).catch(()=>{reject(request);});		
	});
}

// ---------------------------------------------------------

function sendLeaveResponse (request, responseCode) {
	var self = this;

	var response = new MessageFactory.LeaveRESP(request.sessionId, responseCode, request.id, request.version);

	sendResponse.call(self, response, request.responseChannel);
}



// ---------------------------------------------------------
// Device REQ Handler
// ---------------------------------------------------------

function handleDeviceREQ (request) {

	var priv = PRIVATE.get(this);
	var self = this;

	
	Session.getFromDataStore(request.sessionId, priv.redisClient).catch((error)=>{
		logger.warn("unknown session search result: " + error);
	}).then((session)=>{
		if (session)
		{
			logger.silly("handleDeviceREQ() - session found: ", session.id);
			return session.getDevices();
		}else
		{
			return Promise.resolve([]);
		}
	}).then((devices)=>{
	
		var deviceIds = [];
		for (let d of devices) {
			if (d instanceof Device)  deviceIds.push(d.id);
			else if (typeof d === "string") deviceIds.push(d);
		}
		sendDeviceResponse.call(self, request, 0, deviceIds);
		
			
	}).catch(()=>{sendDeviceResponse.call(self, request, 1);});


}
	
	
// ---------------------------------------------------------
	
function sendDeviceResponse (request, responseCode, devices) {
	var self = this;

	var response = new MessageFactory.DeviceRESP(request.sessionId, responseCode, devices, request.id, request.version);

	sendResponse.call(self, response, request.responseChannel);
}




// ---------------------------------------------------------
// Timeline REQ Handler
// ---------------------------------------------------------

function handleTimelineREQ (request) {
	
	var priv = PRIVATE.get(this);
	var self = this;

	logger.info("Received timelines query.");
	Session.getFromDataStore(request.sessionId, priv.redisClient).catch((error)=>{
		logger.warn("unknown context search result: " + error);
	}).then((session)=>{

		if (session)
		{
			// console.log(request.syncTimeline);
			if (request.syncTimeline == false) 
				return session.getTimelines();
			else
				return session.getSyncTimelines();
		}else
		{
			return Promise.resolve([]);
		}
	}).then((timelines)=>{
		
		// console.log(timelines);
		var timelinesInfo = [];	
	
		for (let t of timelines) {
			if (t instanceof Timeline){
				var ti = t.getInfo();
				timelinesInfo.push(ti);			
			}				
		}	
		// logger.silly(timelinesInfo);	
		sendTimelineResponse.call(self, request, 0, timelinesInfo);
		logger.info("Sent timelines query results.");
				
	}).catch(()=>{sendTimelineResponse.call(self, request, 1);});
}





// ---------------------------------------------------------
		
function sendTimelineResponse (request, responseCode, timelines) {
	var self = this;
	var response = new MessageFactory.TimelineRESP(request.sessionId, responseCode, timelines, request.id, request.version);

	sendResponse.call(self, response, request.responseChannel);
}


// ---------------------------------------------------------
// Context REQ Handler .... present for legacy reasons
// ---------------------------------------------------------

function handleContextREQ (request) {


	sendResponse.call(this, "ContextRESP", request, 1, []);
}




// ---------------------------------------------------------
// ContentIdChange Handler
// ---------------------------------------------------------

function handleContentIdChange (message) {
	setContentId.call(this, message);
}

// ---------------------------------------------------------

function setContentId (message) {
	var priv = PRIVATE.get(this);

	priv.serviceState.getSession(message.sessionId).getDevice(message.deviceId).contentId = message.contentId;
	logger.info("Device:", message.deviceId, "is playing content:", message.contentId);
	// TODO Set content ID in DB
}




// ---------------------------------------------------------
// TimelineRegistration REQ Handler
// ---------------------------------------------------------

function handleTimelineRegistrationREQ (request) {

	var priv = PRIVATE.get(this);
	var self = this, timeline;

	var timelineUpdateChannel = "Sessions/" + request.sessionId + "/timelines/" + request.timelineId + "/state";
	
	Session.getFromDataStore(request.sessionId, priv.redisClient).catch((error)=>{
		logger.warn("unknown session search result: " + error);
	}).then((session)=>{
		if (session)
		{
			var timestamp = { wallclockTime: request.correlation.parentTime, contentTime: request.correlation.childTime, speed: 1.0	};
	
			timeline = new Timeline(request.timelineId, session.id, request.contentId, 
				request.timelineType, request.frequency, timelineUpdateChannel, 
				request.senderId, "Device", request.useForSessionSync, false, 
				"urn:wallclock", request.correlation, timestamp);

			// console.log("************* TESTING ***************");
			// console.log(timeline);
			// console.log("*************************************");
	
			return session.addTimeline(timeline, true);
		}
	}).then((success)=>{
		if (success)
		{
			sendTimelineRegistrationResponse.call(self, request, 0, timelineUpdateChannel);
			// register timelineType
			if ((typeof request.timelineType != "undefined") &&
					(typeof request.frequency != "undefined"))
			{
				var timelineTypeKey = "timelinetype:" + request.timelineType;
				priv.redisClient.hmset(timelineTypeKey, ["type", request.timelineType, "frequency", request.frequency]);
			}
			// send NewSyncTimeline to event queue
			// logger.debug("request.useForSessionSync: " + request.useForSessionSync);
			if ((typeof request.useForSessionSync != "undefined") && (request.useForSessionSync == true))
			{
				sendNewSyncTLEventToQueue.call(self, request, timelineUpdateChannel, kSyncControllerQueueKey);
			}
		}else
		{
			sendTimelineRegistrationResponse.call(self, request, 1);
		}
		return success;
	}).then((success)=>{
		if (success)
		{
			return Device.getFromDataStore(timeline.providerId, request.sessionId, priv.redisClient);
		}else
			return null;
	}).then((device)=>{
		if(device)
		{
			return requestDeviceForTimelineUpdates.call(self, device, timeline);
		}else
		{
			return Promise.resolve(-1);
		}	
	}).then((result)=>{
		if (result === 0) logger.info("timeline %s registered and publishing updates.", timeline.id);
		else logger.info("timeline %s registered.", timeline.id);
	}).catch(()=>{
		sendTimelineRegistrationResponse.call(self, request, 1);
		return false;
	});

}


// /**
//  * Checks if a timeline is potentially a base timeline for one of the session's synchronisation timelines
//  * @param {Session} session 
//  * @param {Timeline} timeline 
//  */
// function isACandidateBaseTimeline(session, timeline)
// {

// }


// ---------------------------------------------------------

function sendTimelineRegistrationResponse (request, responseCode, timelineUpdateChannel) {
	var self = this;

	var response = new MessageFactory.TimelineRegistrationRESP(request.sessionId, responseCode, timelineUpdateChannel, request.id, request.version);

	sendResponse.call(self, response, request.responseChannel);
	// sendResponse.call(self, "TimelineRegistrationRESP", request, responseCode, timelineUpdateChannel);
}

// ---------------------------------------------------------

function sendNewSyncTLEventToQueue(request, timelineUpdateChannel, queue)
{
	var priv = PRIVATE.get(this);
	var evhdr = new proto.Header();

	evhdr.setEventtype(proto.EventType.NEW_SYNC_TIMELINE);
	evhdr.setSessionid(request.sessionId);
	evhdr.setSenderid(request.senderId);
	evhdr.setVersion("1.0");
	evhdr.setEventid(MessageIdGenerator.getNewId());


	var evBody= new proto.NewSyncTLEvent();
	evBody.setProviderid(request.senderId);
	evBody.setTimelineid(request.timelineId);
	evBody.setTimelinetype(request.timelineType);
	evBody.setContentid(request.contentId);
	evBody.setFrequency(request.frequency);
	evBody.setChannel(timelineUpdateChannel);
	evBody.setUseforsessionsync(request.useForSessionSync);
	evBody.setWritable(false);

	var timestamp = new proto.PresentationTimestamp();
	timestamp.setContenttime(request.correlation.childTime);
	timestamp.setWallclocktime(request.correlation.parentTime);
	timestamp.setSpeed(request.correlation.speed);
	timestamp.setDispersion(request.correlation.initialError);
	
	evBody.setTimestamp(timestamp);

	var evBodyBytes = evBody.serializeBinary();

	var event = new proto.SyncEvent();
	event.setHeader(evhdr);
	event.setBody(evBodyBytes); 
	var eventBytes = event.serializeBinary();
	var buf = Buffer.from(eventBytes);
	var eventBytesB64 = buf.toString("base64");

	priv.syncCrtlQProducer.produceWithTTL({event: eventBytesB64}, 60000, (err) => {
		if (err) throw err;
		logger.debug("Dispatched  NewSyncTL event for timeline %s to SyncController task queue.", request.timelineId);		    
	});
}


// ---------------------------------------------------------

function sendDelSyncTLEventToQueue(request, timeline)
{
	var priv = PRIVATE.get(this);
	var evhdr = new proto.Header();

	evhdr.setEventtype(proto.EventType.DEL_SYNC_TIMELINE);
	evhdr.setSessionid(request.sessionId);
	evhdr.setSenderid(request.senderId);
	evhdr.setVersion("1.0");
	evhdr.setEventid(MessageIdGenerator.getNewId());


	var evBody= new proto.DelSyncTLEvent();
	evBody.setProviderid(request.senderId);
	evBody.setTimelineid(timeline.id);
	evBody.setTimelinetype(timeline.timelineType);
	evBody.setContentid(timeline.contentId);
	
	var evBodyBytes = evBody.serializeBinary();

	var event = new proto.SyncEvent();
	event.setHeader(evhdr);
	event.setBody(evBodyBytes); 
	var eventBytes = event.serializeBinary();
	var buf = Buffer.from(eventBytes);
	var eventBytesB64 = buf.toString("base64");

	priv.syncCrtlQProducer.produceWithTTL({event: eventBytesB64
	
	}, 60000, (err) => {
		if (err) throw err;
		logger.debug("Dispatched SyncController DelSyncTL event for timeline %s to SyncController task queue.", timeline.id);		    
	});
}

// ---------------------------------------------------------
// TimelineSubscription REQ Handler
// ---------------------------------------------------------

// Removed 'request device for timeline updates' step.
function handleTimelineSubscriptionREQ (request) {
	
	var priv = PRIVATE.get(this);
	var self = this;
	var mytimeline;
	
	Timeline.getFromDataStore(request.timelineId, request.sessionId, priv.redisClient).then((timeline)=>{

		if (timeline){
			logger.debug("handleTimelineSubscriptionREQ() retrieved timeline: ", timeline.serialise());
			mytimeline = timeline;

			sendTimelineSubscriptionResponse.call(self, request, 0, mytimeline);
		}else
		{
			sendTimelineSubscriptionResponse.call(self, request, 1);
		}
	}).catch(()=>{
		//console.log("handleTimelineSubscriptionREQ() THREE ");
		sendTimelineSubscriptionResponse.call(self, request, 1);
	});
}


// ---------------------------------------------------------

function sendTimelineSubscriptionResponse (request, responseCode, timeline) {
	var self = this;
	// console.log("sendTimelineSubscriptionResponse() providerChannel: ", providerChannel);

	var response = new MessageFactory.TimelineSubscriptionRESP(request.sessionId, responseCode, timeline, request.id, request.version);

	sendResponse.call(self, response, request.responseChannel);
}

// ---------------------------------------------------------

function requestDeviceForTimelineUpdates(device, timeline)
{
	//console.log("requestDeviceForTimelineUpdates() ENTER");
	var self = this;

	return new Promise(function (resolve, reject) {
		
		var request = new MessageFactory.TimelineUpdateREQ(device.sessionId, "cloud-sync", kSessionRESPTopic, timeline.id, timeline.timelineType, timeline.contentId);

		var priv = PRIVATE.get(self);

		// var reqbytes = request.serialise();
		
		priv.messenger.sendRequest(request, device.requestChannel, handleTimelineUpdateResponse.bind(self, resolve, reject), {});
		
		//sendRequest (type, sessionId, contextId, senderId, replyChannel, destinationChannel, onresponse, options) 
		// sendRequest.call(self,
		// 	"TimelineUpdateREQ", // type
		// 	device.sessionId, // sessionId
		// 	device.contextId, // contextId
		// 	device.sessionId, // senderId			
		// 	kSessionRESPTopic, // replychannel
		// 	device.requestChannel, // destinationChannel
		// 	handleTimelineUpdateResponse.bind(self, resolve, reject), 
		// 	{},
		// 	timeline.id,
		// 	timeline.timelineType,
		// 	timeline.contentId
		// );
		logger.debug("Sent 'TimelineUpdateREQ' to topic " , device.requestChannel);
	});

}

// ---------------------------------------------------------

function handleTimelineUpdateResponse (resolve, reject, response) {
	// var priv = PRIVATE.get(this);
	// console.log(response);
	logger.debug("Received timelineUpdateRESP.");
	
	if (response.responseCode === 0) {
		resolve(0); 
			
	} else {
		logger.error("requestDeviceForTimelineUpdates:", response);
		reject();
	}
}


// ---------------------------------------------------------
// UnexpectedDeviceExit Message Handler
// ---------------------------------------------------------

function handleUnexpectedDeviceExit(message)
{
	var self = this;
	var priv = PRIVATE.get(this);
	var deviceStatusTopic = "Sessions/" + message.sessionId + "/state";
	var mysession;

	logger.info("Device ", message.senderId, " has left the session ", message.sessionId);

	unRegisterDevice.call(self, message).then((result)=>{
		logger.info("Device ", message.senderId, " deleted from", message.sessionId, ": ", result);

		var m = new MessageFactory.DeviceStatus(message.sessionId, message.senderId, message.senderId, "offline");
		logger.debug("handleUnexpectedDeviceExit() - SessionController sent:" , messageTypeAsString(m) ,  " to '", deviceStatusTopic, "'");

		priv.messenger.send(m, deviceStatusTopic);
		
			
		return Session.getFromDataStore(message.sessionId, priv.redisClient);			
	}).then((session)=>{
		if (session)
		{
			// logger.debug("handleUnexpectedDeviceExit() - session found: ", session.serialise());
			mysession = session;
			return session.getDevices();
		}else
		{
			return Promise.resolve([]);
		}
	}).then((devices)=>{
		if ((devices.length === 0) && (mysession)){
			// logger.debug("Cleaning session: ", mysession.serialise());
				
			return mysession.cleanUp(priv.redisClient); 
		}else
			return Promise.resolve(false);
	}).then((result)=>{
		if (result)
		{
			logger.info("Session '" , mysession.id, "' deleted.");
		}
	}).catch((error)=>{
		logger.warn("session clean-up error: " + error);
	});

}

// ---------------------------------------------------------
// Utility methods
// ---------------------------------------------------------
function sendResponse (response, responseChannel) {

	var priv = PRIVATE.get(this);

	// console.log("---------------");
	// console.log(response);
	// console.log("---------------");
	
	priv.messenger.send(response, responseChannel);
	logger.debug(messageTypeAsString(response), " '" , response.id, "' sent to channel " , responseChannel);
}


function messageTypeAsString(msg)
{
	var msgTypeNames = Object.getOwnPropertyNames(MessageFactory.MessageType);

	return msgTypeNames[msg.messageType];
}
	
// --------------------------------------------------


function firstInSequence(values, asyncFn) {
	return new Promise(function(resolve, reject) {
		// Are there any values to check?
		logger.debug("firstInSequence, values: ", values, " length ", values.length);
		if(values.length === 0) {
		// All were rejected
			logger.debug("firstInSequence - All Rejected");
			reject("All Rejected");
		}else{
			// Try the first value
			asyncFn(values[0]).then(function(val) {
				// Resolved, we're all done
				logger.debug("after reserve call to synccontroller ", val);
				resolve(val);
			}).catch(function() {
				// Rejected, remove the first item from the array and recursively
				// try the next one
				values.shift();			
				firstInSequence(values, asyncFn).then(resolve).catch(reject);
			});
		}	
	});
}

// ---------------------------------------------------------

module.exports =  MTenantSessionController;
	