<?php
// Drives the plugin through classic checkout, the Store API and discovery against a running TheWavly.
// Usage: php run.php input.json   (a JSON file with the TheWavly base URL and four agent orders' headers)
require __DIR__ . '/wp-shim.php';
require __DIR__ . '/../thewavly-agent-checkout/thewavly-agent-checkout.php';

$in  = json_decode( file_get_contents( $argv[1] ), true );
$out = array();
$set = function ( array $options ) use ( $in ) {
	$GLOBALS['shim']['options'] = array_merge( array( 'thewavly_base_url' => $in['base'], 'thewavly_payees' => "demokitchen@okhdfc\nkitchen.in", 'thewavly_allow_test' => 'yes', 'thewavly_mode' => 'require' ), $options );
};
$server = function ( $headers ) {
	unset( $_SERVER['HTTP_WAVLY_AGENT'], $_SERVER['HTTP_WAVLY_PAYMENT_TOKEN'] );
	foreach ( $headers as $k => $v ) { $_SERVER[ 'HTTP_' . strtoupper( str_replace( '-', '_', $k ) ) ] = $v; }
};
$classic = function ( $headers, $total, $number ) use ( $server ) {
	WC()->session->set( 'order_awaiting_payment', 0 ); // A separate checkout session.
	$server( $headers );
	$GLOBALS['shim']['cart_total'] = $total;
	$errors = new ShimErrors();
	do_action( 'woocommerce_after_checkout_validation', array(), $errors );
	$r = array( 'errors' => $errors->errors, 'thrown' => null, 'order' => null );
	if ( ! $errors->errors ) {
		$order = new ShimOrder( $total, $number );
		try { do_action( 'woocommerce_checkout_order_processed', 1, array(), $order ); } catch ( Exception $e ) { $r['thrown'] = $e->getMessage(); }
		$r['order'] = array( 'meta' => $order->meta, 'notes' => $order->notes );
	}
	return $r;
};
$store_api = function ( $headers, $total, $number ) use ( $server ) {
	$server( array() );
	$order = new ShimOrder( $total, $number );
	$r     = array( 'thrown' => null, 'status' => null );
	do_action( 'woocommerce_store_api_checkout_update_order_from_request', $order, new ShimRequest( $headers ) );
	try { do_action( 'woocommerce_store_api_checkout_order_processed', $order ); } catch ( Exception $e ) { $r['thrown'] = $e->getMessage(); $r['status'] = $e->status ?? null; $r['class'] = get_class( $e ); }
	$r['order'] = array( 'meta' => $order->meta, 'notes' => $order->notes );
	return $r;
};

$set( array() );
$out['human']           = $classic( array(), '561.00', '1000' );
$out['classic_ok']      = $classic( $in['orders'][0], '561.00', '1001' );
$out['classic_reuse']   = $classic( $in['orders'][0], '561.00', '1002' );
$out['classic_bad']     = $classic( array( 'Wavly-Agent' => 'kitchen-bot', 'Wavly-Payment-Token' => 'garbage' ), '561.00', '1003' );
$out['store_api_ok']    = $store_api( $in['orders'][1], '561.00', '1004' );
$out['store_api_over']  = $store_api( $in['orders'][2], '599.00', '1005' );
// The charge fails after the approval was used: the plugin gives it back, once
$failed = new ShimOrder( '561.00', '1004' );
$failed->meta = $out['store_api_ok']['order']['meta'];
$out['agent_release'] = null;
try { ( new TheWavly_Merchant( array( 'base_url' => $in['base'] ) ) )->release( $in['orders'][1]['Wavly-Payment-Token'], 'rlk_guessed' ); } catch ( TheWavly_Merchant_Error $e ) { $out['agent_release'] = $e->error_code; }
do_action( 'woocommerce_order_status_failed', 1004, $failed );
do_action( 'woocommerce_order_status_cancelled', 1004, $failed );
$out['uncertain_release'] = $failed->get_meta( '_thewavly_released' );
$failed->paid = true;
do_action( 'thewavly_gateway_order_closed_unpaid', $failed, 'stale-closed-event' );
$out['paid_release'] = $failed->get_meta( '_thewavly_released' );
$failed->paid = false;
do_action( 'thewavly_gateway_order_closed_unpaid', $failed, 'gateway-closed-final-1004' );
do_action( 'thewavly_gateway_order_closed_unpaid', $failed, 'gateway-closed-final-1004' );
$out['payable_statuses'] = apply_filters( 'woocommerce_valid_order_statuses_for_payment', array( 'pending', 'failed' ), $failed );
$out['released'] = array( 'meta' => $failed->meta, 'notes' => $failed->notes );
// A completed order is reported as delivered, once
$done = new ShimOrder( '561.00', '1001' );
$done->meta = $out['classic_ok']['order']['meta'];
do_action( 'woocommerce_order_status_completed', 1001, $done );
do_action( 'woocommerce_order_status_completed', 1001, $done );
$out['delivered'] = array( 'meta' => $done->meta, 'notes' => $done->notes );
$set( array( 'thewavly_mode' => 'label' ) );
$out['label_bad']       = $store_api( array( 'Wavly-Agent' => 'nobody-at-all', 'Wavly-Payment-Token' => 'garbage' ), '100.00', '1006' );
$set( array( 'thewavly_allow_test' => 'no' ) );
$out['live_store_test'] = $classic( $in['orders'][3], '561.00', '1007' );
$set( array( 'thewavly_mode' => 'off' ) );
$out['off']             = $classic( array( 'Wavly-Agent' => 'kitchen-bot', 'Wavly-Payment-Token' => 'garbage' ), '561.00', '1008' );
$set( array() );
// Both routes lose a response *after* the service commits. Reload the WC order between requests.
foreach ( array( 'classic' => array( 4, '2001' ), 'blocks' => array( 5, '2002' ) ) as $route => $fixture ) {
	list( $n, $number ) = $fixture;
	$headers = $in['orders'][ $n ];
	$initial = new ShimOrder( '561.00', $number ); $initial->save();
	if ( 'classic' === $route ) {
		$server( $headers ); WC()->session->set( 'order_awaiting_payment', 0 );
		$GLOBALS['shim']['cart_total'] = '561.00'; $errors = new ShimErrors();
		do_action( 'woocommerce_after_checkout_validation', array(), $errors );
		try { do_action( 'woocommerce_checkout_order_processed', (int) $number, array(), $initial ); }
		catch ( Exception $e ) { $out[ $route . '_pending' ] = $e->getMessage(); }
	} else {
		$server( array() );
		do_action( 'woocommerce_store_api_checkout_update_order_from_request', $initial, new ShimRequest( $headers ) );
		try { do_action( 'woocommerce_store_api_checkout_order_processed', $initial ); }
		catch ( Exception $e ) { $out['blocks_pending'] = array( $e->error_code, $e->status, $e->getMessage() ); }
	}
	$intent = TheWavly_Redemption::get( (int) $number );
	$out[ $route . '_saved' ] = $intent && $intent['reference'] === $number && $intent['amount'] === 56100;
	$order = wc_get_order( (int) $number );
	if ( 'classic' === $route ) {
		$errors = new ShimErrors();
		do_action( 'woocommerce_after_checkout_validation', array(), $errors ); $out['classic_retry_errors'] = $errors->errors;
		do_action( 'woocommerce_checkout_order_processed', (int) $number, array(), $order );
	} else {
		// A different token or changed amount cannot use the existing order to pay.
		do_action( 'woocommerce_store_api_checkout_update_order_from_request', $order, new ShimRequest( $in['orders'][0] ) );
		try { do_action( 'woocommerce_store_api_checkout_order_processed', $order ); }
		catch ( Exception $e ) { $out['blocks_changed_token'] = $e->status; }
		$changed = new ShimOrder( '562.00', $number );
		do_action( 'woocommerce_store_api_checkout_update_order_from_request', $changed, new ShimRequest( $headers ) );
		try { do_action( 'woocommerce_store_api_checkout_order_processed', $changed ); }
		catch ( Exception $e ) { $out['blocks_changed_total'] = $e->status; }
		// Action Scheduler can rebuild the receipt after the original PHP request disappears.
		do_action( 'thewavly_recover_redemption', (int) $number, 1 ); $order = wc_get_order( (int) $number );
		do_action( 'woocommerce_store_api_checkout_update_order_from_request', $order, new ShimRequest( $headers ) );
		do_action( 'woocommerce_store_api_checkout_order_processed', $order );
	}
	$out[ $route . '_recovered' ] = array( $order->get_meta( '_thewavly_accept' ), $order->get_meta( '_thewavly_check' ), TheWavly_Redemption::get( $order->get_id() )['release_key'] === $intent['release_key'] );
	do_action( 'thewavly_gateway_order_closed_unpaid', $order, 'confirmed-unpaid-' . $number );
	$out[ $route . '_released' ] = $order->get_meta( '_thewavly_released' );
}
// An upstream outage before commit stays payable only after a foreground checkout confirms it.
$order = new ShimOrder( '561.00', '2003' ); $order->save();
$server( array() );
do_action( 'woocommerce_store_api_checkout_update_order_from_request', $order, new ShimRequest( $in['orders'][6] ) );
try { do_action( 'woocommerce_store_api_checkout_order_processed', $order ); } catch ( Exception $e ) { $out['uncommitted_pending'] = $e->status; }
do_action( 'thewavly_recover_redemption', $order->get_id(), 1 );
$out['uncommitted_after_worker'] = wc_get_order( $order->get_id() )->get_meta( '_thewavly_accept' );
do_action( 'woocommerce_before_pay_action', $order );
$out['order_pay_notice'] = $GLOBALS['shim']['notices']['error'] ?? array();
do_action( 'woocommerce_before_pay_action', $order );
$out['order_pay_accepted'] = $order->get_meta( '_thewavly_accept' );
do_action( 'thewavly_gateway_order_closed_unpaid', $order, 'confirmed-unpaid-2003' );
$_SERVER['REQUEST_URI'] = '/.well-known/wavly-merchant.json?x=1';
try { do_action( 'parse_request', null ); } catch ( ShimExit $e ) {}
$out['discovery'] = $GLOBALS['shim']['sent'];
do_action( 'woocommerce_settings_tabs_thewavly' );
$out['settings'] = array_column( WC_Admin_Settings::$shown, 'id' );
$out['tabs']     = apply_filters( 'woocommerce_settings_tabs_array', array() );
echo json_encode( $out );
