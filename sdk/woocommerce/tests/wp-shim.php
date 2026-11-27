<?php
// Just enough of WordPress and WooCommerce to drive the plugin's hooks outside WordPress. Not a replacement for testing
// in a real store: it checks the plugin's own logic and its calls into TheWavly.
namespace Automattic\WooCommerce\StoreApi\Exceptions {
	class RouteException extends \Exception {
		public $status;
		public $error_code;
		public function __construct( $error_code, $message, $status ) {
			parent::__construct( $message );
			$this->error_code = $error_code;
			$this->status     = $status;
		}
	}
}

namespace {
	define( 'ABSPATH', __DIR__ . '/' );
	$GLOBALS['shim'] = array( 'hooks' => array(), 'options' => array(), 'cart_total' => '0', 'currency' => 'INR', 'sent' => null );

	function add_action( $hook, $fn, $priority = 10, $args = 1 ) { $GLOBALS['shim']['hooks'][ $hook ][] = $fn; return true; }
	function add_filter( $hook, $fn, $priority = 10, $args = 1 ) { return add_action( $hook, $fn, $priority, $args ); }
	function do_action( $hook, ...$args ) { foreach ( $GLOBALS['shim']['hooks'][ $hook ] ?? array() as $fn ) { call_user_func_array( $fn, $args ); } }
	function apply_filters( $hook, $value, ...$args ) { foreach ( $GLOBALS['shim']['hooks'][ $hook ] ?? array() as $fn ) { $value = call_user_func_array( $fn, array_merge( array( $value ), $args ) ); } return $value; }
	function get_option( $name, $default = false ) { return array_key_exists( $name, $GLOBALS['shim']['options'] ) ? $GLOBALS['shim']['options'][ $name ] : $default; }
	function __( $text, $domain = null ) { return $text; }
	function esc_html__( $text, $domain = null ) { return htmlspecialchars( $text ); }
	function esc_url( $url ) { return $url; }
	function esc_url_raw( $url ) { return $url; }
	function admin_url( $path ) { return 'https://shop.test/wp-admin/' . $path; }
	function plugin_basename( $file ) { return basename( dirname( $file ) ) . '/' . basename( $file ); }
	function sanitize_text_field( $v ) { return trim( preg_replace( '/[\r\n\t ]+/', ' ', strip_tags( (string) $v ) ) ); }
	function wp_unslash( $v ) { return $v; }
	function wp_json_encode( $v ) { return json_encode( $v ); }
	function wp_parse_url( $url, $part = -1 ) { return parse_url( $url, $part ); }
	function nocache_headers() {}
	function wc_add_notice( $message, $type ) { $GLOBALS['shim']['notices'][ $type ][] = $message; }
	function wp_send_json( $data ) { $GLOBALS['shim']['sent'] = $data; throw new ShimExit(); }
	function get_woocommerce_currency() { return $GLOBALS['shim']['currency']; }
	function WC() {
		static $session;
		if ( ! $session ) { $session = new ShimSession(); }
		return (object) array( 'cart' => new ShimCart(), 'session' => $session );
	}
	function wc_get_order( $id ) { return isset( $GLOBALS['shim']['orders'][ $id ] ) ? clone $GLOBALS['shim']['orders'][ $id ] : null; }
	class ShimSession {
		private $values = array();
		public function get( $k ) { return $this->values[ $k ] ?? null; }
		public function set( $k, $v ) { $this->values[ $k ] = $v; }
	}
	// Stand-in for WordPress's unique, non-autoloaded option row. Two reservations cannot overwrite each other.
	class ShimWpdb {
		public $options = 'wp_options', $last_error = '', $rows = array();
		public function prepare( $sql, ...$args ) { return array( $sql, $args ); }
		public function get_var( $stmt ) { return $this->rows[ $stmt[1][0] ] ?? null; }
		public function query( $stmt ) {
			list( $name, $value ) = $stmt[1];
			if ( array_key_exists( $name, $this->rows ) ) { return 0; }
			$this->rows[ $name ] = $value;
			return 1;
		}
		public function delete( $table, $where ) { unset( $this->rows[ $where['option_name'] ] ); }
	}
	$GLOBALS['wpdb'] = new ShimWpdb();

	class ShimExit extends Exception {}
	class ShimCart { public function get_total( $context = 'view' ) { return $GLOBALS['shim']['cart_total']; } }
	class ShimErrors { public $errors = array(); public function add( $code, $message ) { $this->errors[ $code ] = $message; } }
	class ShimRequest {
		private $headers;
		public function __construct( array $headers ) { $this->headers = array_change_key_case( $headers ); }
		public function get_header( $name ) { return $this->headers[ strtolower( $name ) ] ?? null; }
	}
	class ShimOrder {
		public $meta = array(), $notes = array(), $saved = 0, $paid = false;
		private $total, $number;
		public function __construct( $total, $number ) { $this->total = $total; $this->number = $number; }
		public function get_total() { return $this->total; }
		public function get_currency() { return $GLOBALS['shim']['currency']; }
		public function get_id() { return (int) $this->number; }
		public function get_order_number() { return $this->number; }
		public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
		public function get_meta( $k ) { return $this->meta[ $k ] ?? ''; }
		public function get_status() { return 'failed'; }
		public function is_paid() { return $this->paid; }
		public function get_date_paid() { return $this->paid ? 'paid' : null; }
		public function add_order_note( $note ) { $this->notes[] = $note; }
		public function save() { $this->saved++; $GLOBALS['shim']['orders'][ $this->get_id() ] = clone $this; }
	}
	class WC_Admin_Settings {
		public static $shown = null;
		public static function output_fields( $fields ) { self::$shown = $fields; }
		public static function save_fields( $fields ) {}
	}
}
