require.config({
	// The shim config allows us to configure dependencies for
	// scripts that do not call define() to register a module
	paths: {
		'jquery': 'assets/libs/jquery/jquery',
		'underscore': 'assets/libs/underscore-amd/underscore',
		'backbone': 'assets/libs/backbone-amd/backbone',
		'socketio': 'assets/libs/socket.io-client/dist/socket.io',
		'text': 'assets/libs/text/text'
	}
});

require([
	// Load our app module and pass it in
	'router',
	'models/app'
], function(router, app){
	console.log('hashHype Commencing... ', app);
	//The app model stores persistent functions and 'global' properties such as socket.io, and the router
	
	//Start up the router, send the user to appropriate view
	router.initialize(app);
});