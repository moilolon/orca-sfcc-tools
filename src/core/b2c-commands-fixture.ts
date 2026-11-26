// Every command of b2c 2.11.0, by its id, aliases included: what `b2c --help` and the help of
// each topic list on a machine with that version, read from the manifests the CLI ships (its own
// and those of the oclif plugins it loads). The guard's tests walk it: whatever is not in the
// allow list must be refused. Names of a public CLI only; refresh it when the list of allowed
// commands is reviewed against a newer b2c.
export const B2C_VERSION = '2.11.0'

export const B2C_COMMANDS: readonly string[] = `
_test am:clients:create am:clients:delete am:clients:get am:clients:list am:clients:password
am:clients:update am:orgs:get am:orgs:list am:roles:get am:roles:grant am:roles:list
am:roles:revoke am:users:create am:users:delete am:users:get am:users:list am:users:reset
am:users:update auth:client auth:client:token auth:login auth:logout auth:status auth:token
autocomplete autocomplete:create autocomplete:script bm:access-key:create bm:access-key:delete
bm:access-key:get bm:access-key:set bm:roles:create bm:roles:delete bm:roles:get bm:roles:grant
bm:roles:list bm:roles:permissions:get bm:roles:permissions:set bm:roles:revoke bm:users:create
bm:users:delete bm:users:get bm:users:list bm:users:search bm:users:update bm:whoami cap:install
cap:list cap:package cap:pull cap:tasks cap:uninstall cap:validate cip:describe cip:query
cip:report cip:report:bot-traffic-share cip:report:checkout-funnel-dropoff
cip:report:controller-error-rate-trend cip:report:controller-health-scorecard
cip:report:customer-registration-trends cip:report:discount-depth-breakdown
cip:report:inventory-stockout-by-location cip:report:list
cip:report:new-vs-returning-buyer-revenue cip:report:ocapi-client-usage
cip:report:ocapi-requests cip:report:payment-method-performance
cip:report:product-co-purchase-analysis cip:report:promotion-discount-analysis
cip:report:promotion-roi-leaderboard cip:report:recommender-effectiveness
cip:report:remote-include-performance cip:report:revenue-by-channel cip:report:sales-analytics
cip:report:sales-summary cip:report:scapi-cache-hit-ratio cip:report:scapi-error-rate-by-status
cip:report:scapi-latency-distribution cip:report:scapi-traffic-latency
cip:report:search-query-performance cip:report:top-referrers cip:report:top-selling-products
cip:report:zero-result-searches cip:tables client:auth client:auth:token code:activate
code:delete code:deploy code:download code:list code:watch commands:search config:get
config:inspect config:show content:export content:list content:validate debug debug:cli
docs:cache docs:download docs:read docs:schema docs:search docs:skill ecdn:cache:purge
ecdn:certificates:add ecdn:certificates:delete ecdn:certificates:list ecdn:certificates:update
ecdn:certificates:validate ecdn:cipher-suites:get ecdn:cipher-suites:update ecdn:firewall:create
ecdn:firewall:delete ecdn:firewall:get ecdn:firewall:list ecdn:firewall:reorder
ecdn:firewall:update ecdn:logpush:jobs:create ecdn:logpush:jobs:delete ecdn:logpush:jobs:get
ecdn:logpush:jobs:list ecdn:logpush:jobs:update ecdn:logpush:ownership ecdn:mrt-rules:create
ecdn:mrt-rules:delete ecdn:mrt-rules:get ecdn:mrt-rules:rules:delete ecdn:mrt-rules:rules:update
ecdn:mrt-rules:update ecdn:mtls:create ecdn:mtls:delete ecdn:mtls:get ecdn:mtls:issue
ecdn:mtls:list ecdn:mtls:setup ecdn:origin-headers:delete ecdn:origin-headers:get
ecdn:origin-headers:set ecdn:page-shield:notifications:create
ecdn:page-shield:notifications:delete ecdn:page-shield:notifications:list
ecdn:page-shield:policies:create ecdn:page-shield:policies:delete ecdn:page-shield:policies:get
ecdn:page-shield:policies:list ecdn:page-shield:policies:update ecdn:page-shield:scripts:get
ecdn:page-shield:scripts:list ecdn:rate-limit:create ecdn:rate-limit:delete ecdn:rate-limit:get
ecdn:rate-limit:list ecdn:rate-limit:update ecdn:security:get ecdn:security:update
ecdn:speed:get ecdn:speed:update ecdn:waf:groups:list ecdn:waf:groups:update
ecdn:waf:managed-rules:list ecdn:waf:managed-rules:update ecdn:waf:migrate ecdn:waf:owasp:get
ecdn:waf:owasp:update ecdn:waf:rules:get ecdn:waf:rules:list ecdn:waf:rules:update
ecdn:waf:rulesets:list ecdn:waf:rulesets:update ecdn:zones:create ecdn:zones:list help
job:execution:delete job:export job:import job:import-set job:log job:run job:search job:wait
logs:get logs:list logs:tail metrics:controller metrics:ecdn metrics:list metrics:mrt
metrics:ocapi metrics:overall metrics:sales metrics:scapi metrics:scapi-hooks
metrics:third-party mrt:bundle:delete mrt:bundle:deploy mrt:bundle:download mrt:bundle:history
mrt:bundle:list mrt:bundle:save mrt:bundle:upload-v2 mrt:env:access-control:create
mrt:env:access-control:delete mrt:env:access-control:get mrt:env:access-control:list mrt:env:b2c
mrt:env:clone mrt:env:create mrt:env:delete mrt:env:get mrt:env:invalidate mrt:env:list
mrt:env:redirect:clone mrt:env:redirect:create mrt:env:redirect:delete mrt:env:redirect:get
mrt:env:redirect:list mrt:env:redirect:update mrt:env:set-primary mrt:env:update
mrt:env:var:delete mrt:env:var:list mrt:env:var:push mrt:env:var:set mrt:org:b2c
mrt:org:cert:create mrt:org:cert:delete mrt:org:cert:get mrt:org:cert:list
mrt:org:cert:restart-validation mrt:org:list mrt:org:member:add mrt:org:member:get
mrt:org:member:list mrt:org:member:remove mrt:org:member:update mrt:project:create
mrt:project:delete mrt:project:get mrt:project:list mrt:project:member:add
mrt:project:member:get mrt:project:member:list mrt:project:member:remove
mrt:project:member:update mrt:project:notification:create mrt:project:notification:delete
mrt:project:notification:get mrt:project:notification:list mrt:project:notification:update
mrt:project:update mrt:save-credentials mrt:storefront:create mrt:storefront:delete
mrt:storefront:get mrt:storefront:list mrt:storefront:member:add mrt:storefront:member:get
mrt:storefront:member:list mrt:storefront:member:remove mrt:storefront:member:update
mrt:storefront:notification:create mrt:storefront:notification:delete
mrt:storefront:notification:get mrt:storefront:notification:list
mrt:storefront:notification:update mrt:storefront:update mrt:tail-logs mrt:user:api-key
mrt:user:email-prefs mrt:user:profile ods:alias:create ods:alias:delete ods:alias:get
ods:alias:list ods:clone:create ods:clone:get ods:clone:list ods:create ods:delete ods:get
ods:info ods:ips ods:list ods:operations:get ods:operations:list ods:realm:configuration
ods:realm:get ods:realm:list ods:realm:update ods:realm:usage ods:realm:usages ods:reset
ods:restart ods:settings ods:start ods:stop ods:storage ods:update ods:usage plugins plugins:add
plugins:inspect plugins:install plugins:link plugins:remove plugins:reset plugins:uninstall
plugins:unlink plugins:update preferences:global:get preferences:global:list
preferences:global:update preferences:site:get preferences:site:list
preferences:site:preference:get preferences:site:preference:update preferences:site:search
preferences:site:update sandbox:alias:create sandbox:alias:delete sandbox:alias:get
sandbox:alias:list sandbox:clone:create sandbox:clone:get sandbox:clone:list sandbox:create
sandbox:delete sandbox:get sandbox:info sandbox:ips sandbox:list sandbox:operations:get
sandbox:operations:list sandbox:realm:configuration sandbox:realm:get sandbox:realm:list
sandbox:realm:update sandbox:realm:usage sandbox:realm:usages sandbox:reset sandbox:restart
sandbox:settings sandbox:start sandbox:stop sandbox:storage sandbox:update sandbox:usage
scaffold scaffold:generate scaffold:info scaffold:init scaffold:list scaffold:search
scaffold:validate scapi:custom:status scapi:replications:get scapi:replications:list
scapi:replications:publish scapi:replications:wait scapi:schemas:get scapi:schemas:list setup
setup:config setup:default-config:get setup:default-config:set setup:default-config:unset
setup:get setup:ide setup:ide:tsserver-plugin setup:ide:vscode-types setup:inspect
setup:instance setup:instance:create setup:instance:list setup:instance:remove
setup:instance:set-active setup:openshell setup:set setup:skills setup:unset sites:cartridge:add
sites:cartridge:list sites:cartridge:remove sites:cartridge:set sites:cartridges:add
sites:cartridges:list sites:cartridges:remove sites:cartridges:set sites:list slas:client:create
slas:client:delete slas:client:get slas:client:list slas:client:open slas:client:update
slas:token validate version webdav:get webdav:ls webdav:mkdir webdav:put webdav:rm webdav:unzip
webdav:zip
`
  .trim()
  .split(/\s+/)
