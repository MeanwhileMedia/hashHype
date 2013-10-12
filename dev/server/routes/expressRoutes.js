if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'fs',
	'path',
	'forever'
], function (fs, path, forever){
	
	var routes = {
		init: function(server){
			
			//////////
			//render main backbone app
			server.express.get('/', function(req, res){
				
				var htmlPath = path.resolve(__dirname, '..', '..', 'app/index.html');
				
				fs.readFile(htmlPath, 'utf8', function (err, appHtml) {
					res.send(200, appHtml); //send back our html
				});
				
			});
			
			
			/////////
			//github auto restart app on changes
			server.express.post('/gotHub/:pass', function(req, res){
				res.send(200);
				
				//Add some security
				var pass = req.params.pass;
				var commitInfo = JSON.parse(req.body.payload); //see https://help.github.com/articles/post-receive-hooks
				
				if ( pass == server.gotHubPass ){
					var spawn = require('child_process').spawn;
					
					console.log('New github updates available: ', commitInfo );
					console.log('Pulling, and restarting hashHype script: ', server.selfPath);
					
					console.log('TEST: ', server.selfPath, server.gotHubPullOrigin, server.gotHubPullBranch, server.foreverPath, process.env.NODE_ENV);
					console.log('TEST2: ', 'cd '+server.gotHubPullOrigin+' && git pull origin '+server.gotHubPullBranch);
					
					//Only pulls from specified branch, changes to other branches will not be applied to running app
					var pullCmd = spawn('cd '+server.gotHubPullOrigin+' && git pull origin '+server.gotHubPullBranch);
					var pullCmdOut = '';
					pullCmd.stdout.on('data', function (data) {
					  	pullCmdOut = pullCmdOut + data;
					});
					
					pullCmd.stdout.on('data', function (data) {
					  console.log('stdout: ' + data);
					});
					
					pullCmd.stderr.on('data', function (data) {
					  console.log('stderr: ' + data);
					});
					
					pullCmd.on('close', function (code) {
					  console.log('child process exited with code ' + code);
					});


//					pullCmd.on('close', function (code) {
//					  	console.log('git pull complete. Changes merged: ', pullCmdOut);
//						//pull complete. restart app/
//						var stopCmd = spawn('forever stop '+server.selfPath);
//						stopCmd.on('close', function (code) {
//							var startCmd = spawn('node '+server.foreverPath+' '+process.env.NODE_ENV);
//						});
//					});
					
				}

			});
			
		}
	};
	
	return routes;
	
});
