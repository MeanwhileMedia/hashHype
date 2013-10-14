if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'forever',
	'fs',
	'child_process'
], function (forever, fs, childProc){
	
	//What app are we going to monitor?
	var targetApp = __dirname+'/server.js';
	
	//set environment variable
	process.env.NODE_ENV = process.argv[2]; //'production' or 'development'
	
	
		
	function resetLogs(){
		var logsDir = __dirname+'/misc/logs/';
		var logs = {
			forever: logsDir+'forever.log',
			out: logsDir+'out.log', 
			err: logsDir+'err.log'
		}
	
		//first, move existing log files into archive so we don't keep appending into one massive log file
		for(var logName in logs) { 
			if (logs.hasOwnProperty(logName)) {
				//Move the old log file
				fs.renameSync(logs[logName], logsDir+'archive/'+new Date().getTime()+'.'+logName+'.log'); //prepend a timestamp
				//make a new blank one
				fs.writeFileSync(logs[logName], ''); //these need to be prepared before we start forever
			}
		}
		
		return logs;
	}
	
	//Start up our forever Daemon
	var logPaths = resetLogs();
	var hashBack = forever.startDaemon (targetApp, {
		'logFile': logPaths.forever, // Path to log output from forever process (when daemonized)
		'outFile': logPaths.out, // Path to log output from hashBack stdout
		'errFile': logPaths.err// Path to log output from hashBack stderr]
	});
	console.log('hashBack daemon started by Forever.');
	
	hashBack.on('restart', function(){
		console.log('hashBack daemon restarted by Forever.');
		//resetLogs();
	});
	

	
});