if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'fs',
	'path',
	'forever'
], function (fs, path, forever){
	
	var routes = {
		init: function(server){
			
			////////
			//Auto redirect http-->https
			if ( server.forceSsl ){
				console.log("Redirecting all http requests to https.");
				server.express.get('*',function(req,res){ 
					console.log('Secure: ', req.secure);
					if ( !req.secure ) {
						console.log('Incoming request was http, redirecting to https.');
						return res.redirect('https://' + req.get('Host') + req.url);
					} else {
						next();
					}
				});
			} //end if server.forceSsl
			
			
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
			if ( server.enableGotHub ){
				console.log('gotHub enabled.');
				server.express.post('/gotHub/:pass', function(req, res){
					res.send(200);
					
					//Add some security
					var pass = req.params.pass;
					var commitInfo = JSON.parse(req.body.payload); //see https://help.github.com/articles/post-receive-hooks
					console.log('New github updates available: ', commitInfo );
					
					if ( pass == server.gotHubPass ){
						var spawn = require('child_process').spawn;
						
						//Only pulls from specified branch, changes to other branches will not be applied to running app
						var pullCmd = spawn('git', ['pull', 'origin', server.gotHubPullBranch], {cwd: server.gotHubPullOrigin});
						var pullCmdOut = '';
						pullCmd.stdout.on('data', function (data) {
							pullCmdOut = pullCmdOut + data;
						});
						pullCmd.on('close', function (code) {
							console.log('git pull complete. Changes merged: ', pullCmdOut);
							console.log('Restarting server...');
							var startCmd = spawn('forever', ['restart', server.selfPath]);

						});
						
					}
	
				});
			} //end if server.gotHubEnabled

						
		}
	};
	
	return routes;
	
});
