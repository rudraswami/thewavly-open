<?php
/**
 * Plugin Name:          TheWavly Agent Checkout
 * Plugin URI:           https://thewavly.com/developers#merchants
 * Description:          Accept orders from AI agents only when TheWavly verifies the agent and the user's approval. Each approval pays once, for no more than the user approved.
 * Version:              0.2.0
 * Requires at least:    6.3
 * Requires PHP:         7.4
 * Requires Plugins:     woocommerce
 * WC requires at least: 8.0
 * Author:               TheWavly
 * Author URI:           https://thewavly.com
 * License:              Apache-2.0
 * Text Domain:          thewavly-agent-checkout
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/includes/class-thewavly-merchant.php';
require_once __DIR__ . '/includes/class-thewavly-redemption.php';

final class TheWavly_Agent_Checkout {
	const TAB = 'thewavly';

	/** The answer for the order being placed, between validation and order creation (classic checkout). */
	private static $pending = null;

	/** The agent headers of a Store API checkout, read from the REST request. */
	private static $store_api_headers = null;

	public static function init() {
		add_action( 'before_woocommerce_init', array( __CLASS__, 'declare_compatibility' ) );
		add_filter( 'woocommerce_settings_tabs_array', array( __CLASS__, 'add_tab' ), 60 );
		add_action( 'woocommerce_settings_tabs_' . self::TAB, array( __CLASS__, 'show_settings' ) );
		add_action( 'woocommerce_update_options_' . self::TAB, array( __CLASS__, 'save_settings' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( __CLASS__, 'action_links' ) );
		// Classic checkout: refuse before the order is created, redeem once it exists and before payment is taken
		add_action( 'woocommerce_after_checkout_validation', array( __CLASS__, 'classic_validate' ), 20, 2 );
		add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'classic_processed' ), 20, 3 );
		// Block checkout and the Store API, which agents use most: after the order is built, before payment is taken
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( __CLASS__, 'store_api_capture' ), 20, 2 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'store_api_processed' ), 20, 1 );
		add_action( 'thewavly_recover_redemption', array( __CLASS__, 'recover' ), 10, 2 );
		add_action( 'woocommerce_before_pay_action', array( __CLASS__, 'pay_existing' ), 10, 1 );
		add_action( 'woocommerce_delete_order', array( 'TheWavly_Redemption', 'forget' ), 10, 1 );
		// Gateway connectors confirm an order-level closure independently of a local attempt status.
		add_action( 'thewavly_gateway_order_closed_unpaid', array( __CLASS__, 'release' ), 20, 3 );
		add_filter( 'woocommerce_valid_order_statuses_for_payment', array( __CLASS__, 'payable_statuses' ), 20, 2 );
		// What happened next becomes signed evidence: completed orders as delivered, refunds with their amount
		add_action( 'woocommerce_order_status_completed', array( __CLASS__, 'delivered' ), 20, 2 );
		add_action( 'woocommerce_payment_complete', array( __CLASS__, 'debit_confirmed' ), 20, 1 );
		add_action( 'woocommerce_order_refunded', array( __CLASS__, 'refunded' ), 20, 2 );
		// Agents find out that this store takes TheWavly payment tokens
		add_action( 'parse_request', array( __CLASS__, 'discovery' ), 0 );
	}

	public static function declare_compatibility() {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
		}
	}

	// ---- settings ------------------------------------------------------------------------------------------------------
	public static function settings() {
		return array(
			array( 'type' => 'title', 'id' => 'thewavly_title', 'title' => __( 'TheWavly agent checkout', 'thewavly-agent-checkout' ),
				'desc' => __( 'AI agents that buy here send the Wavly-Agent and Wavly-Payment-Token headers. TheWavly checks that the agent is registered and verified, and that its user approved this payment; the token is then used once, for no more than the order total. Orders from people are never touched.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'select', 'id' => 'thewavly_mode', 'default' => 'label', 'title' => __( 'Agent orders', 'thewavly-agent-checkout' ),
				'options' => array(
					'label'   => __( 'Record only: note TheWavly\'s answer on the order', 'thewavly-agent-checkout' ),
					'require' => __( 'Require TheWavly: refuse agent orders it does not verify', 'thewavly-agent-checkout' ),
					'off'     => __( 'Off', 'thewavly-agent-checkout' ),
				),
				'desc_tip' => __( 'Start with Record only, look at the notes on agent orders for a week, then switch to Require.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'textarea', 'id' => 'thewavly_payees', 'default' => '', 'title' => __( 'Your payee identifiers', 'thewavly-agent-checkout' ),
				'desc' => __( 'One per line: the UPI IDs and domain agents are told to pay, such as shop@okhdfc or myshop.in. An approval for another payee is refused. Leave empty to skip this check.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'text', 'id' => 'thewavly_merchant', 'default' => '', 'title' => __( 'Store name agents use', 'thewavly-agent-checkout' ),
				'desc' => __( 'Optional. When set, a token approved for another merchant is refused.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'password', 'id' => 'thewavly_api_key', 'default' => '', 'title' => __( 'Your TheWavly key', 'thewavly-agent-checkout' ),
				'desc' => __( 'Optional. A secret key from your own free TheWavly account. Your redemptions are then recorded as made by an independent store, which helps the agent companies you sell to prove their purchases are checked.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'checkbox', 'id' => 'thewavly_allow_test', 'default' => 'no', 'title' => __( 'Test tokens', 'thewavly-agent-checkout' ),
				'desc' => __( 'Accept test tokens (sk_test_ approvals). Turn this off on a live store.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'text', 'id' => 'thewavly_base_url', 'default' => 'https://thewavly.com', 'title' => __( 'TheWavly address', 'thewavly-agent-checkout' ),
				'desc' => __( 'Leave as is unless TheWavly gave you another address.', 'thewavly-agent-checkout' ) ),
			array( 'type' => 'sectionend', 'id' => 'thewavly_title' ),
		);
	}

	public static function add_tab( $tabs ) {
		$tabs[ self::TAB ] = __( 'TheWavly', 'thewavly-agent-checkout' );
		return $tabs;
	}

	public static function show_settings() {
		WC_Admin_Settings::output_fields( self::settings() );
	}

	public static function save_settings() {
		WC_Admin_Settings::save_fields( self::settings() );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=wc-settings&tab=' . self::TAB ) ) . '">' . esc_html__( 'Settings', 'thewavly-agent-checkout' ) . '</a>' );
		return $links;
	}

	public static function client() {
		$payees = preg_split( '/[\r\n,]+/', (string) get_option( 'thewavly_payees', '' ) );
		$base   = (string) get_option( 'thewavly_base_url', 'https://thewavly.com' );
		return new TheWavly_Merchant( array(
			'mode'       => (string) get_option( 'thewavly_mode', 'label' ),
			'payees'     => $payees,
			'merchant'   => (string) get_option( 'thewavly_merchant', '' ),
			'allow_test' => 'yes' === get_option( 'thewavly_allow_test', 'no' ),
			'api_key'    => (string) get_option( 'thewavly_api_key', '' ),
			'base_url'   => preg_match( '#^(https://|http://(localhost|127\.0\.0\.1)(:\d+)?(/|$))#', $base ) ? $base : 'https://thewavly.com',
		) );
	}

	// ---- the order -----------------------------------------------------------------------------------------------------
	private static function request_headers() {
		$headers = array();
		foreach ( array( 'HTTP_WAVLY_AGENT', 'HTTP_WAVLY_PAYMENT_TOKEN' ) as $key ) {
			if ( isset( $_SERVER[ $key ] ) ) {
				$headers[ $key ] = sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) );
			}
		}
		return $headers;
	}

	private static function paise( $order ) {
		return (int) round( (float) $order->get_total() * 100 );
	}

	private static function refusal( array $answer ) {
		$why = $answer['reasons'] ? ' ' . implode( ' ', $answer['reasons'] ) : '';
		return __( 'This store accepts orders from AI agents only when TheWavly verifies the agent and the user\'s approval.', 'thewavly-agent-checkout' ) . $why;
	}

	/** Durable retry only resolves this order. It never invokes a gateway or starts a payment in the background. */
	private static function schedule_recovery( $order_id, $attempt = 0 ) {
		if ( $attempt < 6 && function_exists( 'as_schedule_single_action' ) ) {
			as_schedule_single_action( time() + 60 * ( 2 ** $attempt ), 'thewavly_recover_redemption', array( (int) $order_id, $attempt + 1 ), 'thewavly', true );
		}
	}

	private static function pending() {
		return new TheWavly_Redemption_Pending( __( 'Your approval is being confirmed. Payment has not been started by this checkout. Retry the same order.', 'thewavly-agent-checkout' ) );
	}

	private static function settle( TheWavly_Merchant $wavly, $order, $request, $answer = null, $background = false ) {
		if ( $order->get_meta( '_thewavly_unpaid_closure' ) || $order->get_meta( '_thewavly_released' ) ) {
			return __( 'This order was closed unpaid. Start a new order with a new approval.', 'thewavly-agent-checkout' );
		}
		$intent = TheWavly_Redemption::get( $order->get_id() );
		if ( ! $intent ) {
			if ( ! $request && 'no' === $order->get_meta( '_thewavly_accept' ) && 'require' === $wavly->mode() ) {
				return __( 'This order needs a verified agent approval before payment.', 'thewavly-agent-checkout' );
			}
			if ( ! $request || $background || 'off' === $wavly->mode() ) {
				return null;
			}
			$answer = $answer ?? $wavly->check( $request, self::paise( $order ), $order->get_currency() );
			// Another checkout may have completed the redemption while verification was in flight.
			if ( ! $answer['accept'] ) {
				$intent = TheWavly_Redemption::get( $order->get_id() );
				if ( ! $intent ) {
					$order->update_meta_data( '_thewavly_accept', 'no' );
					$order->update_meta_data( '_thewavly_agent', $request['agent'] );
					$order->update_meta_data( '_thewavly_answer', wp_json_encode( array( 'reasons' => $answer['reasons'], 'mode' => $wavly->mode() ) ) );
					$order->add_order_note( sprintf( __( 'TheWavly did not verify this order from %1$s. %2$s', 'thewavly-agent-checkout' ), $request['agent'], implode( ' ', $answer['reasons'] ) ) );
					$order->save();
					return $wavly->refuse( $answer ) ? self::refusal( $answer ) : null;
				}
			}
			if ( ! $intent ) {
				$intent = TheWavly_Redemption::reserve( $order, $request, $answer );
				self::schedule_recovery( $order->get_id() );
			}
		}
		if ( ( $request && ( $request['agent'] !== $intent['agent'] || $request['payment_token'] !== $intent['token'] ) )
			|| self::paise( $order ) !== $intent['amount'] || $order->get_currency() !== $intent['currency'] ) {
			return __( 'This order differs from the reserved approval. Use the original order details or start a new order.', 'thewavly-agent-checkout' );
		}
		if ( 'yes' === $order->get_meta( '_thewavly_accept' ) && $order->get_meta( '_thewavly_check' ) === $intent['check'] ) {
			return null;
		}
		if ( 'rejected' === $order->get_meta( '_thewavly_redemption' ) ) {
			return __( 'The approval for this order was refused. Start a new order with a new approval.', 'thewavly-agent-checkout' );
		}
		try {
			if ( $background ) {
				$status = $wavly->inspect( $intent['token'] );
				if ( 'redeemed' !== ( $status['status'] ?? '' ) ) {
					// The request may have died before redeem. Only the customer's checkout can initiate it.
					throw self::pending();
				}
			}
			$paid = $wavly->redeem( array( 'payment_token' => $intent['token'] ), $intent['amount'], $intent['reference'], array( 'payee' => $intent['payee'] ), $intent['release_key'] );
		} catch ( TheWavly_Merchant_Error $e ) {
			// Only explicit, authenticated API rejections are terminal. Transport errors and server failures may follow a commit.
			if ( $e->status >= 400 && $e->status < 500 && in_array( $e->error_code, array( 'already_redeemed', 'token_replaced', 'not_payable', 'expired', 'redemption_conflict', 'amount_exceeds_token', 'payee_mismatch', 'currency_mismatch', 'merchant_mismatch', 'invalid_token' ), true ) ) {
				$order->update_meta_data( '_thewavly_redemption', 'rejected' ); $order->save();
				return __( 'The approval for this order was refused. Start a new order with a new approval.', 'thewavly-agent-checkout' );
			}
			throw self::pending();
		} catch ( Exception $e ) {
			throw self::pending();
		}
		if ( true !== ( $paid['release_key_bound'] ?? null ) || 'paid' !== ( $paid['status'] ?? '' )
			|| $intent['check'] !== ( $paid['check'] ?? null ) || $intent['amount'] !== ( $paid['amount_paise'] ?? null )
			|| $intent['reference'] !== ( $paid['payment_reference'] ?? null ) || empty( $paid['receipt'] ) ) {
			throw self::pending();
		}
		if ( $wavly->key_refused ) {
			/* translators: %s: reason TheWavly gave */
			$order->add_order_note( sprintf( __( 'TheWavly refused this store\'s key (%s), so the order went ahead without it and does not count as an independent store. Check "Your TheWavly key" in the plugin settings.', 'thewavly-agent-checkout' ), $wavly->key_refused ) );
		}
		$order->update_meta_data( '_thewavly_redemption', 'confirmed' );
		$order->update_meta_data( '_thewavly_accept', 'yes' );
		$order->update_meta_data( '_thewavly_agent', $intent['agent'] );
		$order->update_meta_data( '_thewavly_check', $intent['check'] );
		$order->update_meta_data( '_thewavly_receipt', $paid['receipt'] );
		$order->save();
		$who = $intent['name'] . ' (' . $intent['agent'] . ')';
		$proof = ! empty( $paid['verify_url'] ) ? ' ' . sprintf( __( 'Proof of the approval, to keep with the order: %s', 'thewavly-agent-checkout' ), esc_url_raw( $paid['verify_url'] ) ) : '';
		$order->add_order_note( sprintf( __( 'TheWavly verified this order from %1$s: the user approved it, and the approval is now used. Check %2$s.', 'thewavly-agent-checkout' ), $who, $intent['check'] ) . $proof );
		return null;
	}

	public static function recover( $id, $attempt = 0 ) {
		$order = wc_get_order( $id );
		if ( ! $order || $order->is_paid() || $order->get_date_paid() ) { return; }
		try {
			self::settle( self::client(), $order, null, null, true );
		} catch ( TheWavly_Redemption_Pending $e ) {
			self::schedule_recovery( $id, $attempt );
		}
	}

	public static function pay_existing( $order ) {
		try {
			$error = self::settle( self::client(), $order, null );
		} catch ( TheWavly_Redemption_Pending $e ) {
			$error = $e->getMessage();
		}
		// WC_Form_Handler fires this hook outside its try/catch. Its gateway only runs with zero error notices.
		if ( $error ) { wc_add_notice( $error, 'error' ); }
	}

	public static function classic_validate( $data, $errors ) {
		self::$pending = null;
		$wavly = self::client();
		if ( 'off' === $wavly->mode() ) {
			return;
		}
		$request = $wavly->read( self::request_headers() );
		if ( ! $request ) {
			return;
		}
		$total = (int) round( (float) WC()->cart->get_total( 'edit' ) * 100 );
		$awaiting = WC()->session ? (int) WC()->session->get( 'order_awaiting_payment' ) : 0;
		$intent = $awaiting ? TheWavly_Redemption::get( $awaiting ) : null;
		if ( $intent && $intent['token'] === $request['payment_token'] && $intent['agent'] === $request['agent'] ) {
			self::$pending = array( $request, null, $awaiting );
			return;
		}
		$answer = $wavly->check( $request, $total, get_woocommerce_currency() );
		if ( $wavly->refuse( $answer ) ) {
			$errors->add( 'thewavly', self::refusal( $answer ) );
			return;
		}
		self::$pending = array( $request, $answer, null );
	}

	public static function classic_processed( $order_id, $posted, $order = null ) {
		$order = $order ? $order : wc_get_order( $order_id );
		if ( ! $order ) { return; }
		list( $request, $answer, $expected ) = self::$pending ?? array( null, null, null );
		self::$pending = null;
		if ( $expected && $expected !== (int) $order->get_id() ) {
			throw new Exception( __( 'Resume the original order to confirm this approval.', 'thewavly-agent-checkout' ) );
		}
		if ( $request && WC()->session ) {
			// WC normally saves this once payment starts. Keep this checkout resumable if redeem loses its response first.
			WC()->session->set( 'order_awaiting_payment', $order->get_id() );
		}
		$error = self::settle( self::client(), $order, $request, $answer );
		if ( $error ) { throw new Exception( $error ); }
	}

	public static function store_api_capture( $order, $request ) {
		$headers = array();
		foreach ( array( TheWavly_Merchant::AGENT_HEADER, TheWavly_Merchant::TOKEN_HEADER ) as $name ) {
			$value = $request->get_header( $name );
			if ( $value ) {
				$headers[ $name ] = sanitize_text_field( $value );
			}
		}
		self::$store_api_headers = $headers ? $headers : null;
	}

	public static function store_api_processed( $order ) {
		$wavly = self::client();
		$headers = self::$store_api_headers ? self::$store_api_headers : self::request_headers();
		self::$store_api_headers = null;
		$request = $wavly->read( $headers );
		try {
			$error = self::settle( $wavly, $order, $request );
		} catch ( TheWavly_Redemption_Pending $e ) {
			if ( class_exists( '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException' ) ) {
				throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException( 'thewavly_redemption_pending', $e->getMessage(), 503 );
			}
			throw $e;
		}
		if ( $error ) {
			if ( class_exists( '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException' ) ) {
				throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException( 'thewavly_agent_order_refused', $error, 403 );
			}
			throw new Exception( $error );
		}
	}

	public static function payable_statuses( $statuses, $order ) {
		if ( $order && ( $order->get_meta( '_thewavly_unpaid_closure' ) || $order->get_meta( '_thewavly_released' ) ) ) {
			return array();
		}
		return $statuses;
	}

	/** Private server-side hook for a gateway connector that has confirmed final unpaid closure. */
	public static function release( $order_or_id, $closure_reference, $retry = 0 ) {
		$order = is_object( $order_or_id ) ? $order_or_id : wc_get_order( $order_or_id );
		if ( ! $order || $order->get_meta( '_thewavly_released' ) ) {
			return;
		}
		$reference = is_string( $closure_reference ) ? sanitize_text_field( $closure_reference ) : '';
		if ( '' === $reference || strlen( $reference ) > 150 || $order->is_paid() || $order->get_date_paid() ) {
			return;
		}
		list( $token, $key ) = self::credentials( $order );
		if ( ! $token || ! $key ) { return; }
		$order->update_meta_data( '_thewavly_unpaid_closure', $reference );
		$order->save();
		try {
			self::client()->release( $token, $key, 'Gateway confirmed unpaid closure: ' . $reference );
			$order->update_meta_data( '_thewavly_released', 'yes' );
			$order->add_order_note( __( 'The gateway confirmed the order closed unpaid. The user’s TheWavly approval was given back.', 'thewavly-agent-checkout' ) );
		} catch ( Exception $e ) {
			/* translators: %s: reason */
			$order->add_order_note( sprintf( __( 'TheWavly could not give the approval back: %s', 'thewavly-agent-checkout' ), $e->getMessage() ) );
			if ( $retry < 5 && function_exists( 'as_schedule_single_action' ) ) {
				as_schedule_single_action( time() + 60 * ( 2 ** $retry ), 'thewavly_gateway_order_closed_unpaid', array( $order->get_id(), $reference, $retry + 1 ), 'thewavly', true );
			}
		}
		$order->save();
	}

	/** Older plugin versions saved these two fields as protected metadata. New capabilities stay outside order exports. */
	private static function credentials( $order ) {
		$intent = TheWavly_Redemption::get( $order->get_id() );
		return array( $intent['token'] ?? $order->get_meta( '_thewavly_token' ), $intent['release_key'] ?? $order->get_meta( '_thewavly_release_key' ) );
	}

	public static function delivered( $order_id, $order = null ) {
		$order = $order ? $order : wc_get_order( $order_id );
		if ( ! $order || 'yes' !== $order->get_meta( '_thewavly_accept' ) || $order->get_meta( '_thewavly_delivered' ) ) {
			return;
		}
		list( $token, $key ) = self::credentials( $order );
		if ( ! $token || ! $key ) { return; }
		$items = array();
		if ( method_exists( $order, 'get_items' ) ) {
			foreach ( $order->get_items() as $item ) {
				$items[] = array( 'description' => substr( (string) $item->get_name(), 0, 200 ), 'quantity' => (int) $item->get_quantity() );
			}
		}
		try {
			self::client()->fulfil( $token, $key, 'delivered', array( 'items' => $items ? array_slice( $items, 0, 50 ) : null ) );
			$order->update_meta_data( '_thewavly_delivered', 'yes' );
			$order->add_order_note( __( 'Delivery reported to TheWavly as signed evidence for the agent\'s user.', 'thewavly-agent-checkout' ) );
		} catch ( Exception $e ) {
			/* translators: %s: reason */
			$order->add_order_note( sprintf( __( 'TheWavly could not record the delivery: %s', 'thewavly-agent-checkout' ), $e->getMessage() ) );
		}
		$order->save();
	}

	/** The payment went through: confirm the debit to TheWavly from the store's own account, when a key is set. */
	public static function debit_confirmed( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || 'yes' !== $order->get_meta( '_thewavly_accept' ) || $order->get_meta( '_thewavly_debit_confirmed' ) ) {
			return;
		}
		list( $token, $key ) = self::credentials( $order );
		if ( ! $token || ! $key ) {
			return;
		}
		$reference = (string) $order->get_transaction_id();
		$reference = '' !== $reference ? $reference : (string) $order->get_order_number();
		try {
			$done = self::client()->confirm( $token, $key, (int) round( (float) $order->get_total() * 100 ), $reference );
			if ( null !== $done ) {
				$order->update_meta_data( '_thewavly_debit_confirmed', 'yes' );
				$order->add_order_note( __( 'Debit confirmed to TheWavly from this store\'s own account.', 'thewavly-agent-checkout' ) );
			}
		} catch ( Exception $e ) {
			/* translators: %s: reason */
			$order->add_order_note( sprintf( __( 'TheWavly could not record the debit confirmation: %s', 'thewavly-agent-checkout' ), $e->getMessage() ) );
		}
		$order->save();
	}

	public static function refunded( $order_id, $refund_id ) {
		$order  = wc_get_order( $order_id );
		$refund = $refund_id ? wc_get_order( $refund_id ) : null;
		if ( ! $order || ! $refund || 'yes' !== $order->get_meta( '_thewavly_accept' ) ) {
			return;
		}
		list( $token, $key ) = self::credentials( $order );
		if ( ! $token || ! $key ) { return; }
		$paise = (int) round( abs( (float) $refund->get_amount() ) * 100 );
		if ( $paise <= 0 ) {
			return;
		}
		try {
			self::client()->fulfil( $token, $key, 'refunded', array( 'amount_paise' => $paise ) );
			$order->add_order_note( __( 'Refund reported to TheWavly as signed evidence for the agent\'s user.', 'thewavly-agent-checkout' ) );
		} catch ( Exception $e ) {
			/* translators: %s: reason */
			$order->add_order_note( sprintf( __( 'TheWavly could not record the refund: %s', 'thewavly-agent-checkout' ), $e->getMessage() ) );
		}
		$order->save();
	}

	public static function discovery( $wp ) {
		$path = isset( $_SERVER['REQUEST_URI'] ) ? wp_parse_url( esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ), PHP_URL_PATH ) : '';
		if ( '/.well-known/wavly-merchant.json' !== $path ) {
			return;
		}
		$wavly = self::client();
		if ( 'off' === $wavly->mode() ) {
			return;
		}
		nocache_headers();
		wp_send_json( $wavly->discovery() );
	}
}

TheWavly_Agent_Checkout::init();
