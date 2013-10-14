if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'fs'
], function (fs){

	var logMan = {
		
		logsDir: __dirname+'/', //main 'logs' folder
		
		/////////
		getLogPaths: function(){

			var logs = {
				forever: logMan.logsDir+'forever.log',
				out: logMan.logsDir+'out.log', 
				err: logMan.logsDir+'err.log'
			}
			return logs;
			
		}, //end getLogPaths
		
		
		//////////
		archive: function(){
			
			var logs = logMan.getLogPaths();
		
			//first, move existing log files into archive so we don't keep appending into one massive log file
			for(var logName in logs) { 
				if (logs.hasOwnProperty(logName)) {
					//Move the old log file
					fs.renameSync(logs[logName], logMan.logsDir+'archive/'+new Date().getTime()+'.'+logName+'.log'); //prepend a timestamp
					//make a new blank one
					fs.writeFileSync(logs[logName], ''); //these need to be prepared before we start forever
				}
			}
			
		} //end archive
		
		
	} //end archiveLogs
	
	return logMan;
	
});