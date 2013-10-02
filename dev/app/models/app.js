define([
	'backbone', 
	'socketio'
], function(Backbone, io){
	
	var connectHashBack = function(){
		//The user just landed on a page that needs to send/receive updates from the hashBack server
		//update the apps hashBackSocket property with an active connection. 
		//Individual views will bind to .on events on the socket
		if ( this.hashBackSocket == null ){
			this.hashBackSocket = io.connect('http://lyle.mean.to');
			console.log( 'Connection opened to hashBack via socket.io:', this.hashBackSocket );
			
			this.hashBackSocket.on('connectResponse', function (data) {
				console.log('hashBack connection response: ', data);
			});
		}
	}
	
	/////////////
	// Build our appModel, then return it
	var appModel = Backbone.Model.extend({
		defaults: {
			router: null,
			connectHashBack: connectHashBack,
			hashBackSocket: null
		}
	});
	
	// Return the initialized appModel
	return new appModel();
	
});