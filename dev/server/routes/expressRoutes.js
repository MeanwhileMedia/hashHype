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
					console.log('Pulling, and restarting hashHype script: ', server.scriptPath);
					
					//Only pulls from specified branch, changes to other branches will not be applied to running app
					var pullCmd = spawn('git', [ 'pull', server.gotHubPullOrigin, server.gotHubPullBranch ]);
					var pullCmdOut = ''
					pullCmd.stdout.on('data', function (data) {
					  	pullCmdOut = pullCmdOut + data;
					});
					pullCmd.on('close', function (code) {
					  	console.log('git pull complete. Changes merged: ', pullCmdOut);
						//pull complete. restart app/
						var restartCmd = spawn('forever', [ 'restart', server.scriptPath ]);
					});
					
				}

			});
			
		}
	};
	
	return routes;
	
});
