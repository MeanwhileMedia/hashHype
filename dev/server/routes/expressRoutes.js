if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	//'express',
], function (){
	
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
				
//				res.render("index", {
//				  	appData: { 'sampleData': 'Test' }
//				}, function(){
//					
//					res.send(200);
//					
//				});
				
			});
			
			//express.post('/:reqType', reqAction);
			
		}
	};
	
	return routes;
	
});
