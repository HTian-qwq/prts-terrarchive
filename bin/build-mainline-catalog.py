#!/usr/bin/env python3
"""Build evidence-labelled Endfield navigation; standard library only.
Community explicit lists supply display order, original assets supply classification.
Same-name joins stay unresolved; ID suffixes never supply mission order.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re

GAME_VERSION = '1.6.3_11010254-4'
COMMUNITY = 'https://endfield.wiki.gg/wiki/Mission/Main?oldid=63259'
INK = 'https://endfield.wiki.gg/wiki/Sanctuary_of_Ink?oldid=65256'
# Verbatim ordered mission titles from the community page's explicit <ol> lists.
PROCESSES = [
 (1,0,'N/A',['e0'],'Process: Cold Start|Process: Awakening'),
 (1,1,'The Broken Lands',['e1'],'Break the Siege|Valley Reboot|Rally and Unite|Westward into the Vale|Secure Sanctuary|Building an Outpost|Through the Haze|Fort Showdown'),
 (1,2,'The Turbid Heavens',['e1'],'Paving the Way|Work Preparation|Maintenance Progress'),
 (1,3,'Path of Ascension',['e2'],'The Mission Continues|Cross the Science Park|Park Way Party|Walk in the Park|Mystery in the Building|Down the Hill|Shattered Veins|Lodespring Crossing|Cradle of the Ages|Eve of Battle'),
 (1,4,'Smoking Embers',['e3','e4'],'Entering the Endgame|Counterstrike Brewing|Scaldings of Utjug|Frontline Rush|Undying Cinders|Temporary Peace|Mysterious Signal|Conference of the Four|Work Preparation'),
 (2,1,'Lost in the Marsh',['e5'],'Arrival at Wuling|Stumbling Into Qingbo Stockade|Destination Wuling'),
 (2,2,'The Way of Water',['e6'],'A Glance of Astonishment|Ready the Easterlies|Of Grace and Gentle Might|The Surging Tide|Where Danger Sleeps'),
 (2,3,'The Long Feud',['e7','c27'],"Unexpected Attack|Deep in the Mire|The Flow Splits Course|Surging From a Withered Spring|A River Restless in Still Winds|Another Wave Comes Crashing In|Ripples Spread Throughout the Flow|Purity Reveals the Stubborn Stone|'Twas One River That Gave Us Drink"),
 (2,4,'Tales of Old',['e8'],'Like Fire and Ice|A Lethal Invitation|Phantom Wisps|Awaiting Thine Coming|Free Will'),
 (2,5,'Wrothful Tide',['e9'],'Thus Rise the Wave and Wind|Tremors of the Crashing Tide|Where Friendship Was Made'),
 (2,6,'Ponderous Load',['e10'],'A Breach Starts with a Crack|Patience Makes Greatness|Forged at the Very Beginning|Kindred Souls Who Share a Vision'),
 (2,7,'Ruins in the Miasma',['e11'],'Bravely Breach the Hostile Winds|Thus Begins the Homeward March|A Past Shared by the Swordmancers|Same Old Faces in a Place Transformed|Warily Returns the Wandering Vigile|Finally Breaks the Hanging Clouds|"Homecoming"|Stubbornly Lingers the Setting Sun|Freedom of Expansion'),
 (2,8,'Paint with Fresh Ink',['e12'],None),
]
VERSIONS = [('1.0','零号委托'),('1.1','新潮起，故渊离'),('1.2','春晓时'),('1.3','寻遗散记'),('1.4','向渊行'),('1.5','雪凇幽梦'),('1.6','丹青渡')]


def load(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def normalized(text: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', '', text).replace('’', "'")).strip()


def build(game_root: Path, update_root: Path) -> dict:
    table = game_root / 'tables' / GAME_VERSION / 'Table'
    runtime = game_root / 'json' / GAME_VERSION / 'Data/Json/MissionRuntimeAsset'
    index_path = update_root / 'wiki_generation/export/task_index.json'
    tasks = load(index_path)
    text = load(table / 'TextTable.json')
    languages = {lang: load(table / f'I18nTextTable_{lang}.json') for lang in ('CN','EN')}

    def localized(key, lang):
        return normalized(languages[lang].get(str(text.get(key, {}).get('id')), ''))

    def cn_for_en(english):
        matches = {normalized(languages['CN'].get(k,'')) for k,v in languages['EN'].items() if normalized(v) == normalized(english)}
        matches.discard('')
        return next(iter(matches)) if len(matches) == 1 else ''

    metadata = {}
    by_name = defaultdict(list)
    # Sort only for stable serialization, never as chronological evidence.
    for path in sorted(runtime.glob('*.json')):
        raw = load(path)
        mid = raw.get('missionId')
        if not mid or path.stem != mid:
            continue
        key = raw.get('missionName',{}).get('key','')
        exported = tasks.get(mid,{})
        row = {'id':mid, 'name':localized(key,'CN') or exported.get('name',''),
               'english_name':localized(key,'EN'), 'mission_type':raw.get('missionType'),
               'chapter_bitmask':raw.get('missionChapterBitmask'),
               'char_id':raw.get('charId',''), 'sort_id':raw.get('sortId'),
               'source':str(path), 'name_key':key,
               'export_type':exported.get('type'), 'export_series':exported.get('series'),
               'export_level':exported.get('level'),
               'has_local_story':bool(exported.get('fragments')) and exported.get('level') != 'skip',
               'char_linked':bool(raw.get('charId'))}
        metadata[mid] = row
        # Assets can reuse a parent's localization key. That proves a name
        # alias, not a second independently named mission in the display list.
        row['name_alias_of'] = key[:-5] if key.endswith('_name') and key != mid + '_name' else None
        if row['english_name'] and row['name_alias_of'] is None:
            by_name[normalized(row['english_name'])].append(mid)

    chapters = []
    for ordinal,(chapter,process,english,series,names) in enumerate(PROCESSES,1):
        missions,unresolved = [],[]
        if names is not None:
            for position,name in enumerate(names.split('|'),1):
                candidates = by_name.get(normalized(name),[])
                if len(candidates) != 1:
                    unresolved.append({'order':position,'english_name':name,'candidate_ids':candidates,
                                       'reason':'ambiguous_name' if candidates else 'name_not_matched'})
                    continue
                mid = candidates[0]
                missions.append({'id':mid,'name':metadata[mid]['name'],'english_name':name,
                                 'order':position,'order_source':COMMUNITY,
                                 'has_local_story':metadata[mid]['has_local_story']})
        else:
            # Local membership only: no latest-process mission chronology claimed.
            for mid,row in metadata.items():
                if row['export_series'] in series and row['has_local_story'] and row['mission_type'] == 0:
                    missions.append({'id':mid,'name':row['name'],'english_name':row['english_name'],
                                     'order':None,'order_source':None,'has_local_story':True})
        summaries = list(dict.fromkeys(t['series_name'] for sid in series for t in tasks.values()
                         if t.get('series') == sid and t.get('series_name')))
        title_cn = cn_for_en(english) if english != 'N/A' else ''
        summary_documents = [name + ' · 剧情总结' for name in summaries]
        chapter_metadata = [metadata[m['id']] for m in missions]
        chapters.append({'id':f'chapter{chapter}-process{process}','title':('序章' if process == 0 else title_cn or english),
            'aliases':list(dict.fromkeys([english] + summaries + ([title_cn] if title_cn else []))),
            'title_status':'display_alias' if process == 0 else 'localized_community_process_title',
            'title_en':english,'chapter_number':chapter,
            'chapter_title':localized(f'chapter{chapter}_name','CN'),
            'process_number':process,'order':ordinal,
            'collection_names':list(dict.fromkeys(m['name'] for m in missions if m['has_local_story'] and m['name'])),
            'summary_title':summary_documents[0] if summary_documents else '', 'summary_titles':summary_documents,
            'summary_series':series,
            'mission_metadata':chapter_metadata,
            'classification':{'basis':'MissionRuntimeAsset.missionType',
                              'game_mission_types':sorted({r['mission_type'] for r in chapter_metadata if r['mission_type'] is not None}),
                              'export_types':sorted({r['export_type'] for r in chapter_metadata if r['export_type']}),
                              'char_linked_mission_ids':[r['id'] for r in chapter_metadata if r['char_linked']]},
            'collection_order':'community_explicit_order' if names is not None else 'unknown',
            'summary_coverage_note':'Exported series summaries: one series may cover several processes; one process may use several series.',
            'version':'1.6' if (chapter,process)==(2,8) else None,
            'missions':missions,'unresolved_missions':unresolved,
            'mission_order_status':'community_explicit_order' if names is not None else 'unavailable_membership_only',
            'classification_source':'MissionRuntimeAsset.missionType; export_type/series are separate ID-pattern grouping metadata',
            'evidence':[{'kind':'community','url':COMMUNITY if names is not None else INK,
                         'claim':'chapter/process and explicit mission list order' if names is not None else 'Chapter II Process VIII; local mission membership only, no mission order claimed'}]})
    versions = []
    official_bounds = {
        '1.1': ('https://endfield.gryphline.com/en-us/news/8907', 3),
        '1.2': ('https://endfield.gryphline.com/en-us/news/0751', 6),
        '1.4': ('https://endfield.gryphline.com/en-us/news/5200', 7),
    }
    introduced_processes = {'1.1':[3], '1.2':[4,5,6], '1.4':[7], '1.6':[8]}
    for version,title in VERSIONS:
        evidence = [{'kind':'user_confirmed','claim':'version number and Chinese title'}]
        status = 'unknown'
        if version in official_bounds:
            url, boundary = official_bounds[version]
            evidence.append({'kind':'official','url':url,
                             'claim':f'Main Mission available up to Chapter II Process {boundary}; announcement is a cumulative endpoint, not an explicit list of newly introduced processes.'})
            status = 'official_supported'
            if version == '1.2':
                status = 'derived_between_official_boundaries'
                evidence.append({'kind':'derivation','urls':[official_bounds['1.1'][0],url],
                                 'claim':'Previous confirmed endpoint III, current endpoint VI: IV-VI are the intervening main-story units; version titles/numbers follow user confirmation.'})
        elif version == '1.6':
            status = 'community_supported'
            evidence.append({'kind':'community','url':INK,'claim':'version 1.6, Chinese 丹青渡, Main Mission up to Chapter II Process VIII'})
        versions.append({'version':version,'title':title,
                         'chapter_ids':[f'chapter2-process{n}' for n in introduced_processes.get(version,[])],
                         'chapter_ids_semantics':'new main-story navigation units, not cumulative availability',
                         'mapping_status':status,'evidence':evidence})
    by_id = {chapter['id']:chapter for chapter in chapters}
    for version in versions:
        for cid in version['chapter_ids']:
            by_id[cid]['version'] = version['version']
            by_id[cid]['version_mapping_status'] = version['mapping_status']
            by_id[cid]['version_evidence'] = version['evidence']
    relevant = {m['id'] for c in chapters for m in c['missions']}
    relevant.update(mid for mid,row in metadata.items() if row['export_series'] in {f'e{i}' for i in range(13)} | {'c27'})
    return {'schema_version':1,'source_game_version':GAME_VERSION,'versions':versions,'chapters':chapters,
        'mission_metadata':[metadata[mid] for mid in sorted(relevant)],
        'ordering_note':'Display order and pre-1.6 mission order cite community explicit tables. Latest mission order is unknown. Serialization, ID suffixes, sortId=0 and fragment order do not establish chronology.',
        'classification_note':'Original mission_type is independent of export_type/series. c27 has mission_type=0 and char_id=chr_0027_tangtang despite export_type=c. chapter_bitmask is not a chapter ID.',
        'sources':{'task_index':str(index_path),'mission_runtime_directory':str(runtime),
                   'text_table':str(table/'TextTable.json'),'i18n_cn':str(table/'I18nTextTable_CN.json'),
                   'i18n_en':str(table/'I18nTextTable_EN.json'),
                   'chapter_bridge':str(table/'ChapterMissionChapterTable.json')},
        'gaps':['No runtime chapter/process membership table located in this snapshot.',
                'Version-to-process mapping remains unconfirmed for 1.0/1.3/1.5; unknown does not mean no new main story. Official notices give cumulative endpoints, while chapter_ids records new navigation units; 1.2 IV-VI is derived from adjacent confirmed endpoints.',
                'Work Preparation and Freedom of Expansion preserve same-name ambiguity.',
                'No cross-mission ordering evidence for e12; five story members have null order.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--game-root',type=Path,default=Path('/home/cloudstack/sda/endfieldgamedata'))
    parser.add_argument('--update-root',type=Path,default=Path('/home/cloudstack/ai-data/prts.chat/var/data_updates/endfield-1.6.3-11010254-4'))
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'resources/endfield-mainline.json')
    args = parser.parse_args()
    result = build(args.game_root,args.update_root)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'output':str(args.output),'processes':len(result['chapters']),
                      'verified_missions':sum(len(c['missions']) for c in result['chapters']),
                      'unresolved':sum(len(c['unresolved_missions']) for c in result['chapters'])},ensure_ascii=False))


if __name__ == '__main__':
    main()
