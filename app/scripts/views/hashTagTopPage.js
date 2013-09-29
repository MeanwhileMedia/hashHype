define(['backbone'], function(Backbone) {
	
	var app = null; //maintain a reference to the main app view (app.js)
	
	var hashTagTopPage = Backbone.View.extend({
		
		//Instead of generating a new element, bind to the existing skeleton of the App already present in the HTML. 
		el: $("#hashTagTopPage"), 
		
		events: {
			//"click #showHashTop": "showHashTop"
		},
	
		initialize: function() {
			app = this.options.app; //set our semi global (see top)
			console.log( 'HashHype top tags requested. App: ', app );
			
			//load up socket.io to stream the top hash list from hashBack
			this.streamTopHashTags();
			
			//load our hashTagTopList collection, which add themselves into the topWheel as wedges
//			require(['collections/hashTagTopList'], function(hashTagTopList) {
//				new hashTagTopList;
//			});
		},
		
		streamTopHashTags: function(){
			//load up socket.io so we can listen for updates to the hashTagsTop feed
			app.connectHashBack();
		}
		
	});
	
	return hashTagTopPage;
	
});