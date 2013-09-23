define(['backbone'], function(Backbone) {
	var App = Backbone.View.extend({
		initialize: function() {
			console.log( 'Wahoo!' );
			
			require(['socketio'], function (socketio) {
				console.log( socketio );
			});
		}
	});
	
	return App;
});