if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'forever',
	'fs',
	'child_process'
], function (forever, fs, childProc){
	console.log('test1')
	//What app are we going to monitor?
	var targetApp = __dirname+'/server.js';
	
	//set environment variable
	process.env.NODE_ENV = process.argv[2]; //'production' or 'development'
	
	//first, move existing log files into archive so we don't keep appending into a massive log file
	var logsDir = __dirname+'/misc/logs/';
	var logs = {
		forever: logsDir+'forever.log',
		out: logsDir+'out.log', 
		err: logsDir+'err.log'
	}
	
	for(var logName in logs) { 
		if (logs.hasOwnProperty(logName)) {
			//Move the old log file
			fs.renameSync(logs[logName], logsDir+'archive/'+new Date().getTime()+'.'+logName+'.log'); //prepend a timestamp
			//make a new blank one
			fs.writeFileSync(logs[logName], ''); //these need to be prepared before we start forever
		}
	}
	
	//make sure that we stop our app before starting it. If it is not yet running, the 'close' event will still be thrown.
	console.log('test2');
	var stopCmd = childProc.exec('forever stop '+targetApp, function(){
		
		console.log('test4');
		///Start up our forever Daemon
		var hashBack = forever.startDaemon (targetApp, {
			'logFile': logs.forever, // Path to log output from forever process (when daemonized)
			'outFile': logs.out, // Path to log output from hashBack stdout
			'errFile': logs.err// Path to log output from hashBack stderr]
		});
		console.log('hashBack daemon started by Forever.');
		
	});
	
	
	
	
//	var stopCmd = childProc.spawn('forever', ['stop', targetApp]);
//	console.log('test3', targetApp)
//	
//	stopCmd.stdout.on('data', function (data) {
//	  console.log('stdout: ' + data);
//	});
//	
//	stopCmd.stderr.on('data', function (data) {
//	  console.log('stderr: ' + data);
//	});
//
//
//
//	stopCmd.on('close', function (code) {
//		
//		console.log('test4');
//		///Start up our forever Daemon
//		var hashBack = forever.startDaemon (targetApp, {
//			'logFile': logs.forever, // Path to log output from forever process (when daemonized)
//			'outFile': logs.out, // Path to log output from hashBack stdout
//			'errFile': logs.err// Path to log output from hashBack stderr]
//		});
//		console.log('hashBack daemon started by Forever.');
//		
//	});

});