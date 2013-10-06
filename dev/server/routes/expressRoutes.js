if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	'fs',
	'path'
], function (fs, path){
	
	var routes = {
		init: function(express){
			
			//render main app
			express.get('/', function(req, res){
				
				console.log( 'path: ', path.resolve(__dirname, '..', '..', 'app') );
				
				fs.readFile(path.resolve(__dirname, '..', '..', 'app'), function (err, data) {
					res.send(200, data);
					
					console.log(data);
				});

				//res.send(200, 'some html');
				//console.log('App index served to client');
				
//				console.log('Attempting to render app/index.html');
//				res.render('index', function(){
//					res.send(200);
//				});
				
			});
			
			//express.post('/:reqType', reqAction);
			
		}
	};
	
	return routes;
	
});
