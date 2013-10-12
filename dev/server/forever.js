if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'forever',
	'nodemailer',
	'fs'
], function (forever, nodemailer, fs){

	//set environment variable
	process.env.NODE_ENV = process.argv[2]; //'production' or 'development'
	
	//first, move existing log files into archive so we don't keep appending into a massive log file
	var logs = {
		forever: __dirname+'/logs/forever.log',
		out: __dirname+'/logs/out.log', 
		err: __dirname+'/logs/err.log'
	}
	
	for(var logName in logs) { 
		if (logs.hasOwnProperty(logName)) {
			//Move the old log file
			fs.renameSync(logs[logName], __dirname+'/logs/archive/'+new Date().getTime()+'.'+logName+'.log'); //prepend a timestamp
			//make a new blank one
			fs.writeFileSync(logs[logName], ''); //these need to be prepared before we start forever
		}
	}
	
//	//Start up our forever Daemon
//	var hashBack = forever.startDaemon (__dirname+'/server.js', {
//		'logFile': logs.forever, // Path to log output from forever process (when daemonized)
//		'outFile': logs.out, // Path to log output from hashBack stdout
//		'errFile': logs.err,// Path to log output from hashBack stderr]
//	});
	
	console.log('hashBack daemon started by Forever.');
	console.log(hashBack);
	
	
	
//	//Start with forever
//	var hashBack = new (forever.Monitor)(__dirname+'/server.js', {
//		max: 100,
//		silent: false,
//		'logFile': __dirname+'/logs/forever.log', // Path to log output from forever process (when daemonized)
//		'outFile': __dirname+'/logs/out.log', // Path to log output from hashBack stdout
//		'errFile': __dirname+'/logs/err.log',// Path to log output from hashBack stderr]
//		'watch': false,
//		'append': true //append logs
//		//'watchDirectory': __dirname, //for auto restart on changes
//		//'watchIgnoreDotFiles': '.foreverignore'
//	});
//	
//	hashBack.on('error', function(err){
//		//send a log email
//
//		// Create a SMTP transport object
//		var transport = nodemailer.createTransport("SMTP", {
//			service: 'Gmail', // use well known service
//			auth: {
//				user: "hashHype.logs@gmail.com",
//				pass: "c5Upubru"
//			}
//		});
//		
//		// Message object
//		var message = {
//			// sender info
//			from: "hashHype.logs@gmail.com",
//			to: "hashHype.logs@gmail.com",
//			subject: 'hashBack Error',
//			text: err,
//		};
//		
//		transport.sendMail(message, function(error){
//			if(error){
//				console.log('Error occured: ' + error.message);
//				return;
//			}
//			console.log('Log email sent successfully.');
//			transport.close(); // close the connection pool
//		});
//		
//	});
//	//hashBack.on('restart', function(forever){
//	//});
//	
//	hashBack.start();
	
	
});