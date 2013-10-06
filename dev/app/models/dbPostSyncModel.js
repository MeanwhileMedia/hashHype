
//Send data to server via a post request
define([
  	'backbone'
], function(Backbone) {

	//when this model changes, those changes will be sent to the url set below
	
	var Message = Backbone.Model.extend({
		url: 'http://localhost:8080/messages'
	});
	return Message;
  
});
