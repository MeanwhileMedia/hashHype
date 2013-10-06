if (typeof define !== 'function') { var define = require('amdefine')(module) } //required for node.js to use define

define([
	//'express',
], function (){
	
	var routes = {
		init: function(socket){

			socket.on('someAction', function (data) {
				//TODO
				//twitter streaming api
				//var twitTopTrends = require('./collections/getTwitTopTrends.js');
				//twitTopTrends.initialize();
				
				//socket.emit('news', { hello: 'world' });
			});
			
		}
	};
	
	return routes;
	
});