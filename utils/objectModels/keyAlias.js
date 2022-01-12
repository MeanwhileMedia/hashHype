// This is a very simple object that points from own key to another. In redisClient, when this object is returned from a 'get' command,
// redisClient will automatically proceed to fetch the keyAlias.parentKey object and return that data to it's get cback.
// NOTE: ONLY supported by the redis get command (strings)
const keyAliasObjModel = {

    createKeyAliasObject: function(props = {}) {
        if (!props.parentKey) {
            console.warn(`Can't create a keyAlias because no props.parentKey was defined.`);
            return null;
        }
        const keyAliasObject = {
            class: 'keyAlias',
            parentKey: props.parentKey
        };

        return keyAliasObject;
    }

}; // end keyAliasObjModel


export default keyAliasObjModel;
