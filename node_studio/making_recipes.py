"""Explicit, editable craft recipes, never presented as model inference."""

LABELS = {
    'blood': {'splatter':'血迹飞溅', 'soak':'血迹浸染', 'drip':'血迹流淌', 'contact':'血迹擦抹'},
    'slash': {'slit':'刀口', 'frayed':'撕裂毛边', 'hole':'破洞'},
    'wear': {'scuff':'擦伤', 'fade':'磨白', 'mud_splatter':'泥点', 'mud_smear':'泥污', 'dust':'积尘', 'water_stain':'水渍'},
    'burn': {'char':'仿炭化', 'smoke':'烟熏', 'scorched_edge':'焦边过渡'},
}


def effect_key(stroke):
    kind = stroke['type']
    default = {'blood':'splatter','slash':'slit','wear':'scuff','burn':'char'}.get(kind, 'unknown')
    subtype = stroke.get('effectSubtype') or stroke.get('bloodBehavior') or default
    return kind, subtype


def recipe(kind, subtype, material='unknown'):
    def step(title, geometry, tools, actions, checkpoint, order, optional=False):
        return {'title':title, 'geometry':geometry, 'method':'manual' if geometry == 'mark' else 'template',
                'templateKind':'定位描线' if geometry == 'mark' else '镂空保护' if geometry == 'protection' else '主体镂空',
                'tools':tools, 'actions':actions, 'checkpoint':checkpoint, 'phase':order, 'optional':optional}
    if kind == 'blood' and subtype == 'splatter':
        return [step('主血斑拍印', 'cut', ['海绵','与材料相容的纺织颜料'],
                     ['按定位十字对齐主体模板，在衣层之间放保护垫', '先在小样上卸去海绵多余颜料，再分薄层轻拍大形状；细小血点后补'],
                     '大形状位置吻合，未出现模板边缘漏色', 30),
                step('外围自然飞溅', 'protection', ['旧牙刷或硬毛刷','外围保护模板'],
                     ['待主斑达到颜料要求的处理状态后换保护模板', '先对废纸试弹刷毛；在保护范围内分次少量飞溅，按参考图保留稀疏区', '保护模板仅限定范围，不要求复制每一个细小血点'],
                     '飞溅方向与疏密接近参考图，范围外保持干净', 40)]
    if kind == 'blood' and subtype in {'soak','drip'}:
        return [step('少量分次浸染' if subtype == 'soak' else '沿流向分次滴染', 'mark', ['滴管或小刷','同材质小样','吸水保护垫'],
                     ['对照定位图标记中心和外缘，不沿硬模板边缘填满', '在同材质小样确认吸收范围；少量加入相容颜料，观察扩散后再补',
                      '流淌需在试样上验证倾斜方向与停留；浸染需保留自然过渡', '干燥后再比较目标，不把屏幕透明度直接当作颜料配比'],
                     '中心、流向或浸润范围接近目标，没有跨衣层污染', 25)]
    if kind == 'blood':
        return [step('接触痕迹擦抹', 'protection', ['海绵或布头','纺织颜料'],
                     ['按定位图露出目标范围，先在小样卸去余料', '顺参考图方向短距离擦抹，保留断续纹理，不反复涂成均匀实色'],
                     '擦抹方向明确，织物纹理仍可见', 30)]
    if kind == 'slash':
        return [step('标出破损位置并手工处理', 'mark', ['可清除标记工具','垫板','小剪刀或镊子'],
                     ['定位图只作描线，MARK 层不得作为机器自动切割指令', '先在纸样核对位置，检查是否跨缝线、受力部位或下层衣片',
                      '需要真实开口时，在小样练习后少量分次剪开，再按设计挑松边缘；不想破坏原衣时用可替换布片模拟'],
                     '开口大小和位置确认，未切到下层或关键接缝', 10)]
    if kind == 'burn':
        return [step('模拟焦痕主体', 'cut' if subtype == 'char' else 'protection', ['海绵','相容的颜料'],
                     ['按定位图覆盖周边，在主体区域分薄层拍印', '采用上色模拟焦痕，不使用明火、热灼或未知材料激光烧蚀'],
                     '主体位置准确，颜色层次以已干的小样为准', 30),
                step('补出烟熏或焦边过渡', 'protection', ['接近干燥的小刷或海绵'],
                     ['换外围保护模板，从主体附近向外围逐渐减少颜料', '软边处不贴着模板外缘涂满，保持不规则、渐弱的过渡'],
                     '边缘没有整齐框线，中心与外围有层次', 35)]
    if kind == 'wear' and subtype in {'scuff','fade'}:
        actions = ['按定位图标明重点，不需要把整块轮廓剪空', '先在同材质小样比较干刷上色与真实打磨效果']
        actions += (['当前材料未确认或为涂层材质：默认只用相容颜料干刷模拟，不自动建议砂磨']
                    if material != 'fabric' else ['确认普通织物小样可承受后，可用细砂纸轻轻局部处理；每次少量，检查背面与强度'])
        return [step('局部磨损或干刷模拟', 'mark', ['小刷','同材质小样','可选细砂纸'], actions,
                     '重点突出且织物结构未被意外削弱', 15)]
    if kind == 'wear' and subtype == 'water_stain':
        return [step('轻薄水渍层次', 'mark', ['小刷','相容的稀薄纺织颜料','保护垫'],
                     ['对照定位范围，在小样上验证渗染和干燥边缘', '少量分次形成浅层痕迹；不要使用真实污水或依靠照片反推稀释比例'],
                     '干燥后可辨识但未压过主效果', 20)]
    if kind == 'wear':
        return [step('泥点飞溅' if subtype == 'mud_splatter' else '积尘或泥污擦拍', 'protection', ['海绵或硬毛刷','纺织颜料'],
                     ['按外围模板保护不处理区域', '泥点采用少量试溅；积尘采用卸料后的轻刷；泥污采用断续擦拍', '完成一层后观察再补，避免涂成平整色块'],
                     '纹理疏密接近参考，未污染保护区域', 20)]
    return [step('人工确认制作方法', 'mark', ['同材质小样'],
                 ['该痕迹暂无已登记的制作配方，仅输出位置参考', '确认工具和小样效果后再施工'], '制作方法已人工确认', 50)]
