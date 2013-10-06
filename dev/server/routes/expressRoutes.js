if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	//'express',
	'../../app/index.ejs'
], function (test){
	
	console.log(test);
	
	var routes = {
		init: function(express){
			
			//render main app
			express.get('/', function(req, res){
				
//				fs.readFile('/etc/passwd', function (err, data) {
//					if (err) throw err;
//					console.log(data);
//				});

				//res.send(200, 'some html');
				//console.log('App index served to client');
				
				console('Attempting to render app/index.html');
				res.render('index', function(){
					res.send(200);
				});
				
			});
			
			//express.post('/:reqType', reqAction);
			
		}
	};
	
	return routes;
	
});
