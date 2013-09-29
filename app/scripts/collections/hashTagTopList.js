var hashTagTopList = Backbone.Collection.extend({
	model: hashTag,
	
	topTwenty : function() {
		//Filter down the list of all top hashTags to just the topTen. 
		//return this.where({done: true});
    }
	
});

var hashTagTop = new hashTagTopList;