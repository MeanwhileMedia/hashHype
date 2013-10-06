
define([
	//'backbone',
], function (){
	
	var routes = {
		init: function(socket){
			
			socket.on('somethingFromServer', function (data) {
				//TODO
				socket.emit('someAction', { my: 'data' });
			});
			
		}
	};
	
	return routes;
	
});