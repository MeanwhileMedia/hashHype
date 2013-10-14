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
				server.express.all('*',function(req, res, next){ 
					if ( !req.secure ) {
						console.log('Incoming request was http, redirecting to https.');
						return res.redirect('https://' + req.get('Host') + req.url);
					} else {
						next();
					}
				});
			} //end if server.forceSsl
			
			
			///////
			//Set Cors headers
			if ( server.enableCors ){
				console.log('CORS enabled.');
				server.express.all('*', function(req, res, next){
					res.header("Access-Control-Allow-Origin", server.allowCorsWith ); //will need to specify https here
					res.header("Access-Control-Allow-Headers", "X-Requested-With");
					
					if (req.method.toUpperCase() === "OPTIONS"){
						console.log('Incoming CORS request: ', req);
						res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
						res.header("Access-Control-Max-Age", 3600); // Seconds.
						res.writeHead(200, { 'content-type' : 'text/plain' } ); //Send success code					
						res.end();
					} else {
						next();
					}
					
				});
				//also serve crossdomain.xml if necc (flash).
				server.express.get('/crossdomain.xml', function(req, res){
					console.log('Incoming CORS request (flash): ', req);
					res.send("<?xml version='1.0' ?>\n\
					<!DOCTYPE cross-domain-policy SYSTEM 'http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd'>\n\
					<cross-domain-policy>\n\
					<allow-access-from domain='"+server.allowCorsWith+"' />\n\
					</cross-domain-policy>\n");
				});
				
			} //end if server.enableCors
			
			
			
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
						var logMan = require(path.resolve(__dirname, '..', 'misc/logs/logMan'));
						
						//Only pulls from specified branch, changes to other branches will not be applied to running app
						var pullCmd = spawn('git', ['pull', 'origin', server.gotHubPullBranch], {cwd: server.gotHubPullOrigin});
						var pullCmdOut = '';
						pullCmd.stdout.on('data', function (data) {
							pullCmdOut = pullCmdOut + data;
						});
						pullCmd.on('close', function (code) {
							console.log('git pull complete. Changes merged: ', pullCmdOut);
							console.log('Restarting server...');
							
							///first archive our logs, so our current logs don't get too long
							logMan.archive();
							
							///var startCmd = spawn('forever', ['restart', server.selfPath]);
							forever.restart(server.selfPath, true);
							
						});
						
					}
	
				});
			} //end if server.gotHubEnabled

						
		}
	};
	
	return routes;
	
});
