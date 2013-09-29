define(['backbone', 'socketio'], function(Backbone, io) {
	
	//set a semi-global reference to main app view to be passed around views. Passed in below to the "init" function
	var app = null; 
	
	var appView = Backbone.View.extend({
		
		///////////
		//Backbone view properties
		
		//Instead of generating a new element, bind to the existing skeleton of the App already present in the HTML. 
		el: $("#appMainWindow"), 
		
		events: {
			"click #showHashTop": "showHashTop"
		},
	
		init: function(self) {
			//console.log( 'HashHype initialized. App: ', app );
			
			//Set a reference to main app view to be passed around views (see top)
			app = self;
			
			//define model listeners
			//this.listenTo(this.model, 'change', this.render);
			
			//TESTING
			this.showHashTop();
		},
		
		
		/////////
		//Main app object properties/methods
		
		//hashBack
		hashBackSocket: null, //the open socket for sending/receiving events
		connectHashBack: function() {
			console.log( 'Now opening a connection to hashBack via socket.io' );
			
			//The user just landed on a page that needs to send/receive updates from the hashBack server
			//update the apps hashBackIo property with an active connection. 
			//Individual views will bind to .on events on the socket
			if ( this.hashBackSocket == null ){
				this.hashBackSocket = io.connect('http://lyle.mean.to');
				
				this.hashBackSocket.on('connectResponse', function (data) {
					console.log('hashBack connection response: ', data);
				});
			}
		},
		
		
		
		/////////////
		//Page Load Methods
		
		showHashTop: function() {
			
			//Load up our top hashtags page view
			require(['views/hashTagTopPage'], function(hashTagTopPage) {
				new hashTagTopPage({app:app}); //pass in app object
			});
			
		}
		
	});

	return appView;
	
});