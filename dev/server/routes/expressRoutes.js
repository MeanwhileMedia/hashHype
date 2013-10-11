if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'fs',
	'path',
	'forever'
], function (fs, path, forever){
	
	var routes = {
		init: function(express){
			
			//////////
			//render main backbone app
			express.get('/', function(req, res){
				
				var htmlPath = path.resolve(__dirname, '..', '..', 'app/index.html');
				
				fs.readFile(htmlPath, 'utf8', function (err, appHtml) {
					res.send(200, appHtml); //send back our html
				});
				
			});
			
			/////////
			//github auto restart app on changes
			express.get('/gotHub/:pass', function(req, res){
				//var pass = req.params.pass; //TODO
				
				console.log('New github updates available. Pulling, and restarting hashHype.');
				forever.stopAll();
			});
			
		}
	};
	
	return routes;
	
});
