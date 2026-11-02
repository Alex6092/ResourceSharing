<?php
// SPDX-License-Identifier: GPL-3.0-or-later
namespace local_filesharing\privacy;
defined('MOODLE_INTERNAL') || die();
class provider implements \core_privacy\local\metadata\provider, \core_privacy\local\request\plugin\provider,
        \core_privacy\local\request\core_userlist_provider {
    public static function get_metadata(\core_privacy\local\metadata\collection $collection): \core_privacy\local\metadata\collection {
        $collection->add_database_table('local_filesharing_code', ['userid' => 'privacy:metadata:userid', 'expires' => 'privacy:metadata:expires'], 'privacy:metadata:codes');
        $collection->add_external_location_link('fileservice', ['userid' => 'privacy:metadata:userid',
            'fullname' => 'privacy:metadata:fullname', 'capabilities' => 'privacy:metadata:capabilities'], 'privacy:metadata:external');
        return $collection;
    }
    public static function get_contexts_for_userid(int $userid): \core_privacy\local\request\contextlist {
        global $DB;
        $list = new \core_privacy\local\request\contextlist();
        if ($DB->record_exists('local_filesharing_code', ['userid' => $userid])) {
            $list->add_from_sql('SELECT id FROM {context} WHERE contextlevel=:level', ['level' => CONTEXT_SYSTEM]);
        }
        return $list;
    }
    public static function export_user_data(\core_privacy\local\request\approved_contextlist $contextlist): void {
        global $DB;
        if (!in_array(\context_system::instance()->id, $contextlist->get_contextids())) {
            return;
        }
        $codes = $DB->get_records('local_filesharing_code', ['userid' => $contextlist->get_user()->id], '', 'id,expires');
        \core_privacy\local\request\writer::with_context(\context_system::instance())->export_data(
            [get_string('pluginname', 'local_filesharing')], (object)['expires' => array_values(array_map(fn($c) => $c->expires, $codes))]);
    }
    public static function delete_data_for_all_users_in_context(\context $context): void {
        global $DB;
        if ($context->contextlevel === CONTEXT_SYSTEM) {
            $DB->delete_records('local_filesharing_code');
        }
    }
    public static function delete_data_for_user(\core_privacy\local\request\approved_contextlist $contextlist): void {
        global $DB;
        if (in_array(\context_system::instance()->id, $contextlist->get_contextids())) {
            $DB->delete_records('local_filesharing_code', ['userid' => $contextlist->get_user()->id]);
        }
    }
    public static function get_users_in_context(\core_privacy\local\request\userlist $userlist): void {
        if ($userlist->get_context()->contextlevel === CONTEXT_SYSTEM) {
            $userlist->add_from_sql('userid', 'SELECT userid FROM {local_filesharing_code}', []);
        }
    }
    public static function delete_data_for_users(\core_privacy\local\request\approved_userlist $userlist): void {
        global $DB;
        if ($userlist->get_context()->contextlevel === CONTEXT_SYSTEM && $userlist->get_userids()) {
            $DB->delete_records_list('local_filesharing_code', 'userid', $userlist->get_userids());
        }
    }
}
