if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	//'express',
], function (){
	
	var routes = {
		init: function(express){
			
			//render main app
			express.get('/', function(req, res){
				
				res.set({
				  	'Content-Type': 'text/plain',
				  	//'Content-Length': '123',
				})
				
				res.render("index", {
				  	appData: { 'sampleData': 'Test' }
				}, function(){
					
					res.send(200);
					console.log('App index served to client');
				});
				
			});
			
			//express.post('/:reqType', reqAction);
			
		}
	};
	
	return routes;
	
});
