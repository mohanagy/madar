const service = require('./service.js')

function cjsHandler(input) {
  return service.helper(input)
}

exports.cjsHandler = cjsHandler
module.exports.alias = cjsHandler
