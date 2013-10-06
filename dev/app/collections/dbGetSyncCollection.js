

define([
	'backbone',
	'models/dbPostSyncModel'
], function(Backbone, dbPostSyncModel){
	
	//Send a model to be populated with db datat from the server.
	//Retreived via a GET request
	
	var Messages = Backbone.Collection.extend({
		model: dbPostSyncModel,
		url: 'http://localhost:8080/messages'
	});
	
	return Messages;
});
