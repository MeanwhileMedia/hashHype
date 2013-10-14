if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'forever',

	'./misc/logs/logMan'
], function (forever, logMan){
	
	//What app are we going to monitor?
	var targetApp = __dirname+'/server.js';
	
	//set environment variable
	process.env.NODE_ENV = process.argv[2]; //'production' or 'development'
	
	//Use logman to get our log paths, and archive the old logs
	logMan.archive();
	var logPaths = logMan.getLogPaths();
	
	//Start up our forever Daemon
	var hashBack = forever.startDaemon (targetApp, {
		'logFile': logPaths.forever, // Path to log output from forever process (when daemonized)
		'outFile': logPaths.out, // Path to log output from hashBack stdout
		'errFile': logPaths.err// Path to log output from hashBack stderr]
	});
	console.log('hashBack daemon started by Forever.');

	
});