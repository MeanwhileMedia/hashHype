if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'fs',
	'path'
], function (fs, path){
	
	var routes = {
		init: function(express){
			
			//////////
			//render main app
			express.get('/', function(req, res){
				
				var htmlPath = path.resolve(__dirname, '..', '..', 'app/index.html');
				
				fs.readFile(htmlPath, 'utf8', function (err, appHtml) {
					res.send(200, appHtml); //send back our html
				});
				
			});
			
			/////////
			//another route
			//express.post('/:reqType', reqAction);
			
		}
	};
	
	return routes;
	
});
