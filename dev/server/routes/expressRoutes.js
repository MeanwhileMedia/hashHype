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
				
				if ( pass == 'd8Syd3M' && commitInfo.repository.name == 'hashHype' ){
					console.log('New github updates available: ', commitInfo );
					console.log('Pulling, and restarting hashHype script: ', server.scriptPath);
					
					var spawn = require('child_process').spawn;
					var cmd = spawn('forever', [ 'restart', server.scriptPath ]); //path.resolve(__dirname, '..', 'server.js')
				}

			});
			
		}
	};
	
	return routes;
	
});
