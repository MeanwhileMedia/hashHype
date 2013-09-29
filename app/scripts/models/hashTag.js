var hashTag = Backbone.Model.extend({
	
	defaults: function() {
		return {
			hashTag: '#hashTag',
			count: 0,
			owner: 'string',
			price: 0
		};
    },
	
	highlight: function() {
		//this.save({done: !this.get("done")});
    },
	
	hover: function() {
		//this.save({done: !this.get("done")});
    }
	
});