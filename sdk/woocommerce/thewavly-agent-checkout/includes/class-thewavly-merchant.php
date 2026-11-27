<?php
/**
 * TheWavly for merchants, in plain PHP: no WordPress needed, so it can be tested and reused on its own.
 *
 * An agent that checks out sends Wavly-Agent (its handle in TheWavly's registry) and Wavly-Payment-Token (the single-use
 * token TheWavly gave it when the user's approval was checked). check() asks TheWavly whether the agent is verified and
 * the payment approved, and adds the store's own checks. redeem() uses the token once, just before charging.
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'THEWAVLY_STANDALONE' ) ) {
	exit;
}

class TheWavly_Merchant_Error extends Exception {
	public $status;
	public $error_code;
	public function __construct( $status, $body ) {
		$message = is_array( $body ) && isset( $body['error']['message'] ) ? $body['error']['message'] : 'TheWavly answered ' . $status;
		parent::__construct( $message );
		$this->status     = $status;
		$this->error_code = is_array( $body ) && isset( $body['error']['code'] ) ? $body['error']['code'] : null;
	}
}

class TheWavly_Merchant {
	const AGENT_HEADER = 'Wavly-Agent';
	const TOKEN_HEADER = 'Wavly-Payment-Token';

	private $base_url;
	private $payees;
	private $merchant;
	private $mode;
	private $allow_test;
	private $http;
	private $api_key;

	/**
	 * @param array $options base_url, payees (list), merchant, mode ("require", "label" or "off"), allow_test, api_key, http
	 *                       (callable(string $url, array $body, array $headers): array{0:int,1:mixed}, for tests or other HTTP
	 *                       clients). api_key is optional: the store's own TheWavly secret key, sent only with redemptions of a
	 *                       token in the key's mode, so they are recorded as made by an independent store.
	 */
	public function __construct( array $options = array() ) {
		$this->base_url   = rtrim( isset( $options['base_url'] ) && $options['base_url'] ? $options['base_url'] : 'https://thewavly.com', '/' );
		$this->payees     = array_values( array_filter( array_map( array( __CLASS__, 'payee_key' ), isset( $options['payees'] ) ? (array) $options['payees'] : array() ) ) );
		$this->merchant   = isset( $options['merchant'] ) && '' !== trim( (string) $options['merchant'] ) ? trim( (string) $options['merchant'] ) : null;
		$this->mode       = isset( $options['mode'] ) && in_array( $options['mode'], array( 'require', 'label', 'off' ), true ) ? $options['mode'] : 'require';
		$this->allow_test = ! empty( $options['allow_test'] );
		$this->api_key    = isset( $options['api_key'] ) && preg_match( '/^sk_(live|test)_[\w-]{20,64}$/', (string) $options['api_key'] ) ? (string) $options['api_key'] : null;
		$this->http       = isset( $options['http'] ) && is_callable( $options['http'] ) ? $options['http'] : array( $this, 'default_http' );
	}

	public function mode() {
		return $this->mode;
	}

	public static function payee_key( $value ) {
		return strtolower( trim( (string) $value ) );
	}

	private static function clean( $value, $max ) {
		if ( ! is_string( $value ) ) {
			return null;
		}
		$value = trim( $value );
		return '' === $value ? null : substr( $value, 0, $max );
	}

	/**
	 * The agent and token an order carries, or null when it declares no agent.
	 *
	 * @param array $headers Header name => value, any case. Also accepts $_SERVER-style HTTP_WAVLY_AGENT keys.
	 */
	public function read( array $headers ) {
		$find = function ( $name ) use ( $headers ) {
			$server = 'HTTP_' . strtoupper( str_replace( '-', '_', $name ) );
			foreach ( $headers as $key => $value ) {
				if ( 0 === strcasecmp( (string) $key, $name ) || $key === $server ) {
					return is_array( $value ) ? reset( $value ) : $value;
				}
			}
			return null;
		};
		$agent = self::clean( $find( self::AGENT_HEADER ), 80 );
		$token = self::clean( $find( self::TOKEN_HEADER ), 4000 );
		return ( $agent || $token ) ? array( 'agent' => $agent, 'payment_token' => $token ) : null;
	}

	/**
	 * TheWavly's answer plus the store's own checks. Never throws: if TheWavly cannot be reached, the answer does not accept.
	 *
	 * @return array accept, agent_order, reasons, agent, payment
	 */
	public function check( $order, $amount_paise = null, $currency = 'INR' ) {
		if ( ! $order ) {
			return array( 'accept' => true, 'agent_order' => false, 'reasons' => array(), 'agent' => null, 'payment' => null );
		}
		$body = array( 'agent' => (string) $order['agent'] );
		if ( $order['payment_token'] ) {
			$body['payment_token'] = $order['payment_token'];
		}
		try {
			$answer = $this->post( '/v1/registry/verify', $body );
		} catch ( Exception $e ) {
			$status = $e instanceof TheWavly_Merchant_Error ? ' (' . $e->status . ')' : '';
			$answer = array( 'accept' => false, 'agent' => null, 'payment' => null, 'reasons' => array( 'TheWavly could not be reached, so the order was not verified' . $status . '.' ) );
		}
		$reasons = isset( $answer['reasons'] ) && is_array( $answer['reasons'] ) ? $answer['reasons'] : array();
		$p       = isset( $answer['payment'] ) && is_array( $answer['payment'] ) ? $answer['payment'] : null;
		if ( 'INR' !== strtoupper( (string) $currency ) ) {
			$reasons[] = 'TheWavly approvals are in rupees; this order is in ' . $currency . '.';
		}
		if ( $p && ! empty( $p['valid'] ) ) {
			if ( is_int( $amount_paise ) && isset( $p['max_amount_paise'] ) && $amount_paise > $p['max_amount_paise'] ) {
				$reasons[] = 'The order total is more than the user approved (at most ₹' . number_format( $p['max_amount_paise'] / 100, 2, '.', '' ) . ').';
			}
			if ( ! empty( $p['payee'] ) && $this->payees && ! in_array( self::payee_key( $p['payee'] ), $this->payees, true ) ) {
				$reasons[] = 'The user approved paying ' . $p['payee'] . ', not this store.';
			}
			if ( empty( $p['livemode'] ) && ! $this->allow_test ) {
				$reasons[] = 'The payment token is a test token.';
			}
		}
		return array(
			'accept'      => ! empty( $answer['accept'] ) && ! $reasons,
			'agent_order' => true,
			'reasons'     => $reasons,
			'agent'       => isset( $answer['agent'] ) ? $answer['agent'] : null,
			'payment'     => $p,
		);
	}

	/** Whether to refuse the order: only in "require" mode, and only an agent order that was not accepted. */
	public function refuse( array $answer ) {
		return 'require' === $this->mode && ! empty( $answer['agent_order'] ) && empty( $answer['accept'] );
	}

	/**
	 * Redeem the token once, just before charging. Throws TheWavly_Merchant_Error when TheWavly refuses.
	 * Repeating it with the same payment reference is safe.
	 */
	public function redeem( array $order, $amount_paise, $payment_reference, $payment = null, $release_key = null ) {
		if ( empty( $order['payment_token'] ) ) {
			throw new InvalidArgumentException( 'The order carries no payment token.' );
		}
		if ( ! is_int( $amount_paise ) || $amount_paise <= 0 ) {
			throw new InvalidArgumentException( 'amount_paise must be the whole number of paise about to be charged.' );
		}
		$reference = self::clean( (string) $payment_reference, 120 );
		if ( ! $reference ) {
			throw new InvalidArgumentException( 'A payment reference, such as the order number, is required.' );
		}
		if ( null === $payment ) {
			$payment = $this->post( '/v1/payment_tokens/inspect', array( 'token' => $order['payment_token'] ) );
		}
		$body = array( 'token' => $order['payment_token'], 'amount_paise' => $amount_paise, 'payment_reference' => $reference, 'currency' => 'INR' );
		if ( null !== $release_key ) {
			$body['release_key_hash'] = rtrim( strtr( base64_encode( hash( 'sha256', $release_key, true ) ), '+/', '-_' ), '=' );
		}
		// Send the payee back only when it is one of this store's
		if ( ! empty( $payment['payee'] ) && ( ! $this->payees || in_array( self::payee_key( $payment['payee'] ), $this->payees, true ) ) ) {
			$body['payee'] = $payment['payee'];
		}
		if ( $this->merchant ) {
			$body['merchant'] = $this->merchant;
		}
		$key = $this->key_for( $order['payment_token'] );
		try {
			return $this->post( '/v1/payment_tokens/redeem', $body, $key );
		} catch ( TheWavly_Merchant_Error $e ) {
			// The store's key is optional: if TheWavly refuses it (revoked, rotated, restricted, blocked address), the sale goes
			// ahead without it, as a redemption that does not count as independent. Never block an order on the key.
			if ( ! $key || ! in_array( $e->status, array( 401, 403 ), true ) || ! in_array( $e->error_code, array( 'unauthenticated', 'insufficient_scope', 'ip_not_allowed' ), true ) ) {
				throw $e;
			}
			$this->key_refused = $e->getMessage();
			return $this->post( '/v1/payment_tokens/redeem', $body );
		}
	}

	/** Set when the last redemption went ahead without the store's key because TheWavly refused it: show it to the store. */
	public $key_refused = null;

	/** The store's key for this token, or null: a live key never goes with a test token, or the other way round. */
	private function key_for( $token ) {
		if ( ! $this->api_key ) {
			return null;
		}
		$parts  = explode( '.', (string) $token );
		$claims = isset( $parts[1] ) ? json_decode( base64_decode( strtr( $parts[1], '-_', '+/' ) ), true ) : null;
		if ( ! is_array( $claims ) ) {
			return null;
		}
		return ! empty( $claims['livemode'] ) === ( 0 === strpos( $this->api_key, 'sk_live_' ) ) ? $this->api_key : null;
	}

	public function inspect( $token ) {
		return $this->post( '/v1/payment_tokens/inspect', array( 'token' => $token ) );
	}

	/**
	 * After the charge: confirm the debit actually taken, from the store's own TheWavly account (api_key), with the
	 * release_key redeem() returned. Lets the agent company show a publicly verifiable level 4. Returns null without a key.
	 */
	public function confirm( $payment_token, $release_key, $amount_paise, $payment_reference ) {
		$key = $this->key_for( $payment_token );
		if ( ! $key ) {
			return null;
		}
		$reference = self::clean( (string) $payment_reference, 120 );
		if ( ! is_int( $amount_paise ) || $amount_paise <= 0 || ! $reference ) {
			throw new InvalidArgumentException( 'confirm needs the whole number of paise debited and the payment reference.' );
		}
		return $this->post( '/v1/payment_tokens/confirm', array( 'token' => (string) $payment_token, 'release_key' => (string) $release_key, 'amount_paise' => $amount_paise, 'payment_reference' => $reference ), $key );
	}

	/** The charge failed after redeem(): give the approval back, with the release_key redeem() returned. Safe to repeat. */
	public function release( $payment_token, $release_key, $reason = null ) {
		$body = array( 'token' => (string) $payment_token, 'release_key' => (string) $release_key );
		if ( $reason ) {
			$body['reason'] = substr( (string) $reason, 0, 200 );
		}
		return $this->post( '/v1/payment_tokens/release', $body );
	}

	/**
	 * Report what happened to the order (delivered, partially_delivered, not_delivered, returned, refunded, cancelled),
	 * proven with the release_key redeem() returned. It becomes signed evidence for the agent company and its user.
	 * $extra may hold items (list of description/quantity), amount_paise (required for refunded), carrier,
	 * tracking_reference, note and occurred_at.
	 */
	public function fulfil( $payment_token, $release_key, $status, $extra = array() ) {
		$body = array_merge( array_filter( $extra, function ( $v ) { return null !== $v; } ), array( 'token' => (string) $payment_token, 'release_key' => (string) $release_key, 'status' => (string) $status ) );
		return $this->post( '/v1/payment_tokens/fulfilment', $body );
	}

	/** What to publish at /.well-known/wavly-merchant.json so agents know to send the headers. */
	public function discovery() {
		return array(
			'accepts'                 => array( 'wavly-payment-token' ),
			'headers'                 => array( 'agent' => self::AGENT_HEADER, 'payment_token' => self::TOKEN_HEADER ),
			'payees'                  => $this->payees,
			'requires_verified_agent' => 'require' === $this->mode,
			'verifier'                => $this->base_url,
		);
	}

	private function post( $path, array $body, $key = null ) {
		list( $status, $data ) = call_user_func( $this->http, $this->base_url . $path, $body, $key ? array( 'Authorization' => 'Bearer ' . $key ) : array() );
		if ( $status < 200 || $status >= 300 ) {
			throw new TheWavly_Merchant_Error( $status, $data );
		}
		return is_array( $data ) ? $data : array();
	}

	/** wp_remote_post inside WordPress, curl elsewhere. */
	public function default_http( $url, array $body, array $headers = array() ) {
		$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $body ) : json_encode( $body );
		if ( function_exists( 'wp_remote_post' ) ) {
			$res = wp_remote_post( $url, array( 'timeout' => 10, 'headers' => array_merge( array( 'Content-Type' => 'application/json', 'User-Agent' => 'thewavly-woocommerce/0.1' ), $headers ), 'body' => $json ) );
			if ( is_wp_error( $res ) ) {
				throw new RuntimeException( $res->get_error_message() );
			}
			return array( (int) wp_remote_retrieve_response_code( $res ), json_decode( wp_remote_retrieve_body( $res ), true ) );
		}
		$ch = curl_init( $url );
		curl_setopt_array( $ch, array( CURLOPT_POST => true, CURLOPT_POSTFIELDS => $json, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_HTTPHEADER => array_merge( array( 'Content-Type: application/json', 'User-Agent: thewavly-woocommerce/0.1' ), array_map( function ( $k, $v ) { return $k . ': ' . $v; }, array_keys( $headers ), $headers ) ) ) );
		$text = curl_exec( $ch );
		if ( false === $text ) {
			$error = curl_error( $ch );
			curl_close( $ch );
			throw new RuntimeException( $error );
		}
		$status = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
		curl_close( $ch );
		return array( $status, json_decode( $text, true ) );
	}
}
