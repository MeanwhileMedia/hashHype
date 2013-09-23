require.config({
	// The shim config allows us to configure dependencies for
	// scripts that do not call define() to register a module
	shim: {
		'socketio': {
			exports: 'io'
		}
	},
	paths: {
		'jquery': 'vendor/jquery/jquery',
		'underscore': 'vendor/underscore-amd/underscore',
		'backbone': 'vendor/backbone-amd/backbone',
		'socketio': 'vendor/socket.io-client/dist/socket.io'
	}
});

require(['views/app'], function(AppView) {
	new AppView;
});