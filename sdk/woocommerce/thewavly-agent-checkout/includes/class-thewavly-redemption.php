<?php
/** An immutable, private checkout reservation, created before redeeming. The order may use either WooCommerce data store. */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class TheWavly_Redemption_Pending extends Exception {}

final class TheWavly_Redemption {
	private static function name( $id ) {
		return 'thewavly_redemption_' . (int) $id;
	}

	public static function get( $order_id ) {
		global $wpdb;
		if ( ! $order_id ) {
			return null;
		}
		// Read the same authoritative row after every reservation, including a concurrent winner.
		$value = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name=%s", self::name( $order_id ) ) );
		if ( $wpdb->last_error || ( null !== $value && ! is_array( json_decode( $value, true ) ) ) ) {
			throw new TheWavly_Redemption_Pending( __( 'The approval record is temporarily unavailable. Retry this order.', 'thewavly-agent-checkout' ) );
		}
		return null === $value ? null : json_decode( $value, true );
	}

	public static function reserve( $order, array $request, array $answer ) {
		global $wpdb;
		$id = $order->get_id();
		if ( ! $id ) {
			throw new TheWavly_Redemption_Pending( __( 'Save the order before confirming its approval.', 'thewavly-agent-checkout' ) );
		}
		$intent = array(
			'agent' => $request['agent'], 'token' => $request['payment_token'], 'check' => $answer['payment']['check'],
			'payee' => $answer['payment']['payee'] ?? null, 'reference' => (string) $order->get_order_number(),
			'amount' => (int) round( (float) $order->get_total() * 100 ), 'currency' => $order->get_currency(),
			'name' => $answer['agent']['name'] ?? $request['agent'],
			'release_key' => 'rlk_' . rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' ),
		);
		// The unique option_name serialises the first binding without replacing it. No autoload or object cache.
		$saved = $wpdb->query( $wpdb->prepare(
			"INSERT INTO {$wpdb->options} (option_name,option_value,autoload) VALUES (%s,%s,'no') ON DUPLICATE KEY UPDATE option_name=option_name",
			self::name( $id ), wp_json_encode( $intent )
		) );
		$winner = false === $saved ? null : self::get( $id );
		if ( ! $winner ) {
			throw new TheWavly_Redemption_Pending( __( 'The approval could not be saved. Retry this order before paying.', 'thewavly-agent-checkout' ) );
		}
		return $winner;
	}

	public static function forget( $order_id ) {
		global $wpdb;
		$wpdb->delete( $wpdb->options, array( 'option_name' => self::name( $order_id ) ) );
	}
}
