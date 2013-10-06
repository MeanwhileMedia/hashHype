define([
  'backbone',
  'underscore',
  'jquery',
  'collections/dbGetSyncCollection',
  'text!templates/showDataFromServer.html'
], function(Backbone, _, jQuery, dataCollectionForView, dataTemplate){
	//each of the models in dataCollectionForView should also have a url param
	//so that when they change, those changes are posted back to the server, and the db is updated
	
	
	var dataView = Backbone.View.extend({
	
		el: '.holder',
		
		render: function () {
			var messages = new dataCollectionForView(); //this collection holds it's target url property
			
			messages.fetch({ //request the data from url via 
				
				success: function(messages) {
					jQuery( dataView.el ).html( _.template(dataTemplate, {messages: messages.models, _:_}));
				}
			});
		
		}
	
	});
  
  return dataView;
  
});
